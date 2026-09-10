import { mkdir, readFile, readlink, lstat, rm, rename, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { nodeFileTrace } from '@vercel/nft'
import { collectDeploymentStaticAssets, copyDeploymentFile, deploymentFiles, type DeploymentStaticAsset } from '../DeploymentAssets'
import { DEPLOYMENT_METADATA_PATH, parseDeploymentMetadata } from '../DeploymentMetadata'

const posix = (path: string) => path.split(sep).join('/')
const modulePath = (path: string) => { const value = posix(path); return value.startsWith('.') ? value : `./${value}` }
const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
const commonRoot = (paths: string[]): string => {
  let root = paths[0]!
  for (const path of paths) while (!inside(root, path)) root = dirname(root)
  return root
}
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Only exact public file paths are CDN-owned. Everything else keeps its original URL. */
export const createVercelRouting = (assets: readonly DeploymentStaticAsset[]) => ({
  version: 3,
  routes: [
    ...assets.map((asset) => ({
      src: `^${escapeRegex(asset.pathname)}$`,
      dest: asset.pathname,
      methods: ['GET', 'HEAD'],
      headers: { 'cache-control': asset.cacheControl, 'content-type': asset.contentType, 'x-content-type-options': 'nosniff' },
      check: true,
    })),
    { src: '/(.*)', dest: '/__vue_ssr_lite' },
  ],
})

const runtimeEntry = (): string => {
  const here = fileURLToPath(import.meta.url)
  if (here.endsWith('.ts')) return resolve(dirname(here), 'VercelRuntime.ts')
  // Resolve the installed framework even if Vite bundled the consumer config.
  return fileURLToPath(new URL('./internal-vercel.mjs', import.meta.resolve('vue-ssr-lite/vite')))
}

/** Additional projection of the portable build. Never evaluate consumer runtime code here. */
export const buildVercelDeployment = async (options: {
  root: string
  clientRoot: string
  serverOutput: string
}): Promise<void> => {
  const { root, clientRoot, serverOutput } = options
  if (!inside(root, clientRoot) || !inside(root, serverOutput) || inside(clientRoot, resolve(root, '.vercel'))) {
    throw new Error('[vue-ssr-lite] Deployment build artifacts must be inside the application root.')
  }
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (![20, 22, 24].includes(nodeMajor)) {
    throw new Error('[vue-ssr-lite] Build Vercel deployments with a supported Node.js version (20, 22 or 24).')
  }
  const metadata = parseDeploymentMetadata(await readFile(resolve(clientRoot, DEPLOYMENT_METADATA_PATH), 'utf8'))
  const staticAssets = await collectDeploymentStaticAssets(clientRoot, metadata)
  const providerRoot = resolve(root, '.vercel')
  const stage = resolve(providerRoot, 'vue-ssr-lite-stage')
  const output = resolve(stage, 'output')
  const functionRoot = resolve(output, 'functions/__vue_ssr_lite.func')
  const entry = resolve(stage, 'entry.mjs')
  await rm(stage, { recursive: true, force: true })
  await mkdir(functionRoot, { recursive: true })
  try {
    const runtimeSpecifier = modulePath(relative(stage, serverOutput))
    // Keep the application's Vite bundle intact: lazy chunks, native packages,
    // import.meta.url and user fs assets retain their Node module semantics.
    await build({
      stdin: {
        contents: [
          `import { createVercelHandler } from ${JSON.stringify(runtimeEntry())}`,
          'import { fileURLToPath } from "node:url"',
          `const root = fileURLToPath(new URL(${JSON.stringify(modulePath(relative(stage, root)) + '/')}, import.meta.url))`,
          'export default createVercelHandler({ root, loadRuntime: async () => {',
          `  const loaded = await import(${JSON.stringify(runtimeSpecifier)})`,
          '  const exported = loaded.default ?? loaded',
          '  const config = typeof exported === "function" ? await exported() : exported',
          `  return { ...config, server: { ...config.server, root, clientOutDir: ${JSON.stringify(posix(relative(root, clientRoot)))} } }`,
          '} })',
        ].join('\n'),
        resolveDir: stage,
        sourcefile: 'vue-ssr-lite-entry.mjs',
      },
      outfile: entry,
      absWorkingDir: root,
      platform: 'node', format: 'esm', target: `node${nodeMajor}`,
      bundle: true, packages: 'external', external: [runtimeSpecifier],
      sourcemap: false, minify: true, legalComments: 'none',
      define: { 'process.env.NODE_ENV': '"production"' },
    })

    // Trace from the filesystem root to include hoisted/workspace and pnpm
    // dependencies. Only referenced files are read/copied, never a root scan.
    const traceRoot = parse(root).root
    const serverFiles = (await deploymentFiles(dirname(serverOutput)))
      .filter((file) => !file.endsWith('.map'))
      .map((file) => resolve(dirname(serverOutput), file))
    // Trace every server chunk so lazy imports also retain external dependencies.
    const trace = await nodeFileTrace([entry, ...serverFiles.filter((file) => /\.[cm]?js$/.test(file))], {
      base: traceRoot, processCwd: root,
      // Do not follow stale projections through an opaque fs expression.
      ignore: (file) => inside(resolve(providerRoot, 'output'), resolve(traceRoot, file)) ||
        inside(output, resolve(traceRoot, file)),
    })
    const files = [...trace.fileList].map((file) => resolve(traceRoot, file))
    files.push(...serverFiles)
    // Use the same exact ownership decision as routing. Templates, manifests,
    // private metadata, SEO files and route-owned assets stay with Core. When
    // middleware/endpoints require dynamic assets, staticAssets is empty and
    // the full client tree remains available to the function.
    const cdnOwnedFiles = new Set(staticAssets.map((asset) => resolve(clientRoot, asset.file)))
    files.push(...(await deploymentFiles(clientRoot))
      .map((file) => resolve(clientRoot, file))
      .filter((file) => !cdnOwnedFiles.has(file)))
    // Explicitly traced server dependencies above retain precedence: application
    // code can genuinely import/read a file that is also served by the CDN.
    const payloadRoot = commonRoot([root, ...files])
    const payload = resolve(functionRoot, 'payload')
    for (const source of [...new Set(files)].sort()) {
      if (inside(output, source)) continue
      if (/^\.env(?:\.|$)|^(?:\.npmrc|\.yarnrc(?:\.yml)?|\.git)$/i.test(basename(source))) {
        throw new Error('[vue-ssr-lite] A server dependency references a local credentials file. Supply secrets through the hosting environment instead.')
      }
      const destination = resolve(payload, relative(payloadRoot, source))
      const information = await lstat(source)
      if (information.isSymbolicLink()) {
        const target = resolve(dirname(source), await readlink(source))
        if (!inside(payloadRoot, target)) throw new Error('[vue-ssr-lite] A traced dependency link escapes the deployment payload.')
        await mkdir(dirname(destination), { recursive: true })
        await symlink(relative(dirname(destination), resolve(payload, relative(payloadRoot, target))), destination)
      } else if (information.isFile()) {
        await copyDeploymentFile(source, destination)
      }
    }
    if (trace.warnings.size) {
      console.warn(`[vue-ssr-lite] Dependency tracing reported ${trace.warnings.size} unresolved or optional references. Verify runtime dependencies before deploying.`)
    }
    const deployedProject = modulePath(posix(relative(functionRoot, resolve(payload, relative(payloadRoot, root))))) + '/'
    const deployedEntry = modulePath(posix(relative(functionRoot, resolve(payload, relative(payloadRoot, entry)))))
    await writeFile(resolve(functionRoot, 'index.mjs'), [
      'import { fileURLToPath } from "node:url"',
      `process.chdir(fileURLToPath(new URL(${JSON.stringify(deployedProject)}, import.meta.url)))`,
      `export default (await import(${JSON.stringify(deployedEntry)})).default`,
      '',
    ].join('\n'))
    await writeFile(resolve(functionRoot, '.vc-config.json'), JSON.stringify({
      runtime: `nodejs${nodeMajor}.x`, handler: 'index.mjs', launcherType: 'Nodejs',
      shouldAddHelpers: false, supportsResponseStreaming: true,
    }, null, 2))
    await mkdir(resolve(output, 'static'), { recursive: true })
    for (const asset of staticAssets) {
      const destination = resolve(output, 'static', `.${asset.pathname}`)
      if (!inside(resolve(output, 'static'), destination)) {
        throw new Error('[vue-ssr-lite] Vite base resolves outside the deployment static directory.')
      }
      await copyDeploymentFile(resolve(clientRoot, asset.file), destination)
    }
    await writeFile(resolve(output, 'config.json'), JSON.stringify(createVercelRouting(staticAssets), null, 2))
    await rm(resolve(providerRoot, 'output'), { recursive: true, force: true })
    await rename(output, resolve(providerRoot, 'output'))
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
