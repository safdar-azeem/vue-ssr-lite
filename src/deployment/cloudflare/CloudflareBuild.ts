import { readFile, rename, rm, mkdir, writeFile, stat } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Plugin as EsbuildPlugin } from 'esbuild'
import { classifyDeploymentPublicAssets, copyDeploymentFile, deploymentFiles, type DeploymentClassifiedAsset } from '../DeploymentAssets'
import { DEPLOYMENT_METADATA_PATH, parseDeploymentMetadata, type DeploymentMetadata } from '../DeploymentMetadata'

export const CLOUDFLARE_OUTPUT_DIRECTORY = 'dist/cloudflare'
export const CLOUDFLARE_COMPATIBILITY_DATE = '2025-12-01'
export const CLOUDFLARE_COMPATIBILITY_FLAGS = ['nodejs_compat', 'enable_request_signal'] as const
/** Workers Static Assets `_headers` supports at most 100 rules. */
const MAX_HEADER_RULES = 100

const posix = (path: string) => path.split(sep).join('/')
const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/**
 * Node modules that `nodejs_compat` does not implement usefully. Importing one
 * would build, then fail (or silently no-op) at runtime, so the build stops.
 */
export const CLOUDFLARE_UNSUPPORTED_NODE_MODULES = new Set([
  'child_process', 'cluster', 'dgram', 'inspector', 'repl', 'trace_events', 'v8', 'vm', 'worker_threads', 'wasi',
])

const nodeBuiltins = new Set(builtinModules.filter((name) => !name.startsWith('_')))
const builtinName = (specifier: string): string | undefined => {
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier
  const top = bare.split('/')[0]!
  return specifier.startsWith('node:') || nodeBuiltins.has(top) ? top : undefined
}

/** Private client artifacts the Worker needs at runtime: templates and build metadata. */
export const isCloudflareEmbeddedClientFile = (file: string): boolean =>
  !/\.map$/i.test(file) &&
  (/\.html?$/i.test(file) || /^\.vite\/[^/]+\.json$/.test(file) || file.startsWith('.vue-ssr-lite/'))

/** Directly served files get their Core cache policy through Workers `_headers`. */
export const createCloudflareAssetHeaders = (assets: readonly DeploymentClassifiedAsset[]): string =>
  assets.map((asset) => [
    asset.pathname,
    `  Cache-Control: ${asset.cacheControl}`,
    '  X-Content-Type-Options: nosniff',
  ].join('\n')).join('\n') + (assets.length ? '\n' : '')

export const createCloudflareWranglerConfig = (options: {
  name: string
  runWorkerFirst: boolean | string[]
}) => ({
  name: options.name,
  main: 'worker.mjs',
  compatibility_date: CLOUDFLARE_COMPATIBILITY_DATE,
  compatibility_flags: [...CLOUDFLARE_COMPATIBILITY_FLAGS],
  // The Worker is already a single self-contained module.
  no_bundle: true,
  assets: {
    directory: 'assets',
    binding: 'ASSETS',
    // Unknown paths reach the Worker so Core returns its own 404 / SSR / SPA
    // response. Cloudflare never substitutes an SPA shell or index.html.
    not_found_handling: 'none',
    html_handling: 'none',
    run_worker_first: options.runWorkerFirst,
  },
})

/** Decide which public files Cloudflare may serve before the Worker runs. */
export const resolveCloudflareAssetRouting = (
  metadata: DeploymentMetadata,
  assets: readonly DeploymentClassifiedAsset[]
): { runWorkerFirst: boolean | string[]; directAssets: DeploymentClassifiedAsset[] } => {
  // Global middleware or legacy endpoints may intercept any path.
  if (metadata.dynamicAssets) return { runWorkerFirst: true, directAssets: [] }
  const seo = assets.filter((asset) => asset.seo)
  const directAssets = assets.filter((asset) => !asset.seo)
  if (directAssets.length > MAX_HEADER_RULES) return { runWorkerFirst: true, directAssets: [] }
  return { runWorkerFirst: seo.length ? seo.map((asset) => asset.pathname) : false, directAssets }
}

const workerName = async (root: string): Promise<string> => {
  let name = basename(root)
  try {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { name?: unknown }
    if (typeof manifest.name === 'string' && manifest.name) name = manifest.name
  } catch { /* Directory name fallback. */ }
  const normalized = name.toLowerCase().replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)
  return normalized || 'vue-ssr-lite-app'
}

const runtimeEntry = (): string => {
  const here = fileURLToPath(import.meta.url)
  if (here.endsWith('.ts')) return resolve(dirname(here), 'CloudflareRuntime.ts')
  return fileURLToPath(new URL('./internal-cloudflare.mjs', import.meta.resolve('vue-ssr-lite/vite')))
}

/** One Vue / Vue Router instance: resolve framework peers from the application. */
const dedupePeers = (root: string): EsbuildPlugin => ({
  name: 'vue-ssr-lite:cloudflare-peers',
  setup(context) {
    context.onResolve({ filter: /^(?:vue|vue-router|@vue\/[^/]+)(?:\/.*)?$/ }, async (args) => {
      if (args.pluginData === 'vue-ssr-lite:peer') return undefined
      const result = await context.resolve(args.path, {
        kind: args.kind, resolveDir: root, importer: args.importer, pluginData: 'vue-ssr-lite:peer',
      })
      return result.errors.length ? undefined : result
    })
  },
})

/** Externalize Workers-provided Node APIs; refuse ones Workers cannot run. */
const nodeBuiltinPolicy = (unsupported: Map<string, Set<string>>): EsbuildPlugin => ({
  name: 'vue-ssr-lite:cloudflare-node-builtins',
  setup(context) {
    context.onResolve({ filter: /.*/ }, (args) => {
      const name = builtinName(args.path)
      if (!name) return undefined
      if (CLOUDFLARE_UNSUPPORTED_NODE_MODULES.has(name)) {
        const importers = unsupported.get(args.path) ?? new Set<string>()
        importers.add(args.importer)
        unsupported.set(args.path, importers)
      }
      return { path: `node:${args.path.replace(/^node:/, '')}`, external: true }
    })
  },
})

const exists = (path: string) => stat(path).then(() => true, () => false)

/**
 * Replace `output` with `stage` without ever leaving no valid output: the
 * previous build is moved aside first and restored if promotion fails.
 */
export const promoteCloudflareOutput = async (
  stage: string,
  output: string,
  move: (from: string, to: string) => Promise<void> = rename
): Promise<void> => {
  const backup = `${output}.previous-${process.pid}-${Date.now().toString(36)}`
  const hadPrevious = await exists(output)
  if (hadPrevious) await move(output, backup)
  try {
    await move(stage, output)
  } catch (error) {
    if (hadPrevious) {
      await rm(output, { recursive: true, force: true }).catch(() => undefined)
      await move(backup, output)
    }
    throw error
  }
  if (hadPrevious) await rm(backup, { recursive: true, force: true })
}

/**
 * Project the portable Vite build into a Cloudflare Workers deployment:
 * dist/cloudflare/{worker.mjs, wrangler.json, assets/}. Never evaluates
 * consumer runtime code. A failure keeps the previous output intact.
 */
export const buildCloudflareDeployment = async (options: {
  root: string
  clientRoot: string
  serverOutput: string
}): Promise<{ output: string; workerBytes: number; assets: number }> => {
  const { root, clientRoot, serverOutput } = options
  const output = resolve(root, CLOUDFLARE_OUTPUT_DIRECTORY)
  if (!inside(root, clientRoot) || !inside(root, serverOutput) || inside(clientRoot, output) || inside(output, clientRoot)) {
    throw new Error('[vue-ssr-lite] Cloudflare build artifacts must be inside the application root and outside the client output.')
  }
  const metadata = parseDeploymentMetadata(await readFile(resolve(clientRoot, DEPLOYMENT_METADATA_PATH), 'utf8'))
  const publicAssets = await classifyDeploymentPublicAssets(clientRoot, metadata)
  const publicFiles = new Set(publicAssets.map((asset) => asset.file))
  const embedded: Record<string, string> = {}
  for (const file of await deploymentFiles(clientRoot)) {
    // Physical SEO files are embedded too: SEO endpoint ownership checks their existence.
    const seoFile = publicAssets.some((asset) => asset.seo && asset.file === file)
    if (!seoFile && (publicFiles.has(file) || !isCloudflareEmbeddedClientFile(file))) continue
    embedded[file] = await readFile(resolve(clientRoot, file), 'utf8')
  }
  const routing = resolveCloudflareAssetRouting(metadata, publicAssets)

  const stage = resolve(root, 'dist', `.cloudflare-stage-${process.pid}-${Date.now().toString(36)}`)
  await rm(stage, { recursive: true, force: true })
  await mkdir(resolve(stage, 'assets'), { recursive: true })
  try {
    const unsupported = new Map<string, Set<string>>()
    await build({
      stdin: {
        contents: [
          `import { createCloudflareWorker } from ${JSON.stringify(runtimeEntry())}`,
          'export default createCloudflareWorker({',
          `  files: ${JSON.stringify(embedded)},`,
          `  assets: ${JSON.stringify(Object.fromEntries(publicAssets.map((asset) => [
            asset.pathname, { cacheControl: asset.cacheControl, contentType: asset.contentType },
          ])))},`,
          `  loadRuntime: () => import(${JSON.stringify(serverOutput)}),`,
          '})',
        ].join('\n'),
        resolveDir: root,
        sourcefile: 'vue-ssr-lite-cloudflare-entry.mjs',
      },
      outfile: resolve(stage, 'worker.mjs'),
      absWorkingDir: root,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      conditions: ['workerd', 'worker', 'import', 'module', 'production'],
      mainFields: ['module', 'main'],
      plugins: [nodeBuiltinPolicy(unsupported), dedupePeers(root)],
      define: {
        'process.env.NODE_ENV': '"production"',
        __VUE_OPTIONS_API__: 'true',
        __VUE_PROD_DEVTOOLS__: 'false',
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
      },
      sourcemap: false, minify: true, legalComments: 'none',
      metafile: true, logLevel: 'silent',
    })
    if (unsupported.size) {
      const details = [...unsupported].map(([specifier, importers]) =>
        `  ${specifier} imported by ${[...importers].map((file) => posix(relative(root, file)) || file).join(', ')}`
      ).join('\n')
      throw new Error(
        '[vue-ssr-lite] The server bundle imports Node.js APIs that Cloudflare Workers cannot run:\n' +
        `${details}\nRemove these imports from server code (or move them behind a Node-only deployment) and rebuild.`
      )
    }
    for (const asset of [...publicAssets]) {
      const destination = resolve(stage, 'assets', `.${asset.pathname}`)
      if (!inside(resolve(stage, 'assets'), destination)) {
        throw new Error('[vue-ssr-lite] Vite base resolves outside the Cloudflare assets directory.')
      }
      await copyDeploymentFile(resolve(clientRoot, asset.file), destination)
    }
    if (routing.directAssets.length) {
      await writeFile(resolve(stage, 'assets', '_headers'), createCloudflareAssetHeaders(routing.directAssets))
    }
    const config = createCloudflareWranglerConfig({ name: await workerName(root), runWorkerFirst: routing.runWorkerFirst })
    await writeFile(resolve(stage, 'wrangler.json'), JSON.stringify(config, null, 2) + '\n')
    const workerBytes = (await stat(resolve(stage, 'worker.mjs'))).size
    await promoteCloudflareOutput(stage, output)
    console.log(
      `[vue-ssr-lite] Cloudflare Worker written to ${posix(relative(root, output))} ` +
      `(worker.mjs ${(workerBytes / 1024).toFixed(1)} KiB, ${publicAssets.length} public assets). ` +
      `Deploy with: npx wrangler deploy -c ${posix(relative(root, output))}/wrangler.json`
    )
    return { output, workerBytes, assets: publicAssets.length }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
