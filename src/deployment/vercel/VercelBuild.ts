import { mkdir, readFile, readlink, lstat, rm, rename, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { nodeFileTrace } from '@vercel/nft'
import { collectDeploymentStaticAssets, copyDeploymentFile, deploymentFiles, type DeploymentStaticAsset } from '../DeploymentAssets'
import { DEPLOYMENT_METADATA_PATH, parseDeploymentMetadata } from '../DeploymentMetadata'
import { SSR_RUNTIME_LOAD_NODE_CODES } from '../../SsrRuntimeLoadDiagnostics'

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

const TRACE_PACKAGE = /^(?:@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)(?:\/[a-z0-9._~+-]+)*$/i

const summarizeTraceWarning = (warning: unknown): string => {
  const record = warning && typeof warning === 'object'
    ? warning as { code?: unknown; message?: unknown }
    : undefined
  const message = typeof record?.message === 'string' ? record.message : String(warning)
  const category =
    record?.code === 'MODULE_NOT_FOUND' || /cannot find|failed to resolve|unresolved/i.test(message)
      ? 'unresolved module'
      : /parse|syntax/i.test(message)
        ? 'parse failure'
        : 'optional reference'
  const candidate = message.match(
    /(?:cannot find (?:module|package)|failed to resolve(?: dependency)?|dependency)\s*["']([^"']+)["']/i
  )?.[1]
  return candidate && TRACE_PACKAGE.test(candidate)
    ? `${category}: ${candidate}`
    : category
}

export const createVercelTraceWarningMessages = (
  warnings: ReadonlySet<unknown>
): string[] => {
  const summaries = new Map<string, number>()
  for (const warning of warnings) {
    const summary = summarizeTraceWarning(warning)
    summaries.set(summary, (summaries.get(summary) ?? 0) + 1)
  }
  return [...summaries]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 8)
    .map(([summary, count]) =>
      `[vue-ssr-lite] Dependency tracing warning (${summary}${count > 1 ? `; ${count} occurrences` : ''}).`
    )
}

const VERCEL_BOOTSTRAP_ERROR_NAMES = [
  'Error',
  'TypeError',
  'ReferenceError',
  'RangeError',
  'SyntaxError',
  'URIError',
  'SsrRuntimeLoadError',
] as const

/** Minimal bootstrap classification. Loader reasons stay on the load-failure path only. */
const createSsrVercelBootstrapDiagnosticSource = (): string => [
  `const codes = ${JSON.stringify(SSR_RUNTIME_LOAD_NODE_CODES)}`,
  `const names = ${JSON.stringify(VERCEL_BOOTSTRAP_ERROR_NAMES)}`,
  'let bootstrapIdFallback = 0',
  'const createBootstrapErrorId = () => {',
  '  try { return "vssl_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16) }',
  '  catch {',
  '    bootstrapIdFallback += 1',
  '    return "vssl_" + (Date.now().toString(16) + bootstrapIdFallback.toString(16).padStart(6, "0")).padStart(16, "0").slice(-16)',
  '  }',
  '}',
  'const readBootstrapException = (error) => {',
  '  let errorType = "Error"',
  '  let message = ""',
  '  let stack = ""',
  '  let code = ""',
  '  try {',
  '    if (typeof error === "string") message = error',
  '    else if (error && (typeof error === "object" || typeof error === "function")) {',
  '      const name = typeof error.name === "string" ? error.name : ""',
  '      const rawCode = typeof error.code === "string" ? error.code : ""',
  '      if (names.includes(name)) errorType = name',
  '      if (typeof error.message === "string") message = error.message.slice(0, 4096)',
  '      if (typeof error.stack === "string") stack = error.stack.slice(0, 8192)',
  '      if (/^[A-Z][A-Z0-9_]{1,80}$/.test(rawCode)) code = rawCode',
  '    }',
  '  } catch {}',
  '  return { errorType, message, stack, code, errorId: createBootstrapErrorId() }',
  '}',
  'const emitBootstrapLog = (diagnostic) => {',
  '  try { console.error(JSON.stringify(diagnostic)) }',
  '  catch { try { console.error("[vue-ssr-lite] Vercel function initialization or invocation failed.") } catch {} }',
  '}',
  'const reportBootstrapFailure = (error) => {',
  '  const fields = readBootstrapException(error)',
  '  let reason = "runtime-load-failed"',
  '  try {',
  '    if (typeof codes[fields.code] === "string") reason = codes[fields.code]',
  '    else if (fields.errorType === "SyntaxError") {',
  '      const line = fields.message.split(/\\r?\\n/, 1)[0] || ""',
  '      if (line.includes("does not provide an export named") || line.startsWith("Named export ") || line.startsWith("[vite] Named export ")) reason = "missing-named-export"',
  '      else if (line.includes("Cannot use import statement outside a module")) reason = "module-format-incompatibility"',
  '      else if (/^(?:Unexpected |Invalid or unexpected token|missing \\) after argument list)/.test(line)) reason = "module-syntax-error"',
  '    }',
  '  } catch {}',
  '  const diagnostic = { level: "error", event: "ssr.bootstrap.failed", phase: "runtime-load", errorType: fields.errorType, reason, errorId: fields.errorId }',
  '  if (fields.code) diagnostic.code = fields.code',
  '  if (fields.message) diagnostic.message = fields.message',
  '  if (fields.stack) diagnostic.stack = fields.stack',
  '  emitBootstrapLog(diagnostic)',
  '  return fields.errorId',
  '}',
  'const reportInvocationFailure = (error) => {',
  '  const fields = readBootstrapException(error)',
  '  const diagnostic = { level: "error", event: "ssr.invocation.failed", errorType: fields.errorType, errorId: fields.errorId }',
  '  if (fields.message) diagnostic.message = fields.message',
  '  if (fields.stack) diagnostic.stack = fields.stack',
  '  emitBootstrapLog(diagnostic)',
  '  return fields.errorId',
  '}',
].join('\n')

/** The function entry itself must cold-load without evaluating application code. */
export const createVercelFunctionBootstrap = (
  deployedProject: string,
  deployedEntry: string
): string => [
  'import { fileURLToPath } from "node:url"',
  `process.chdir(fileURLToPath(new URL(${JSON.stringify(deployedProject)}, import.meta.url)))`,
  'let handlerPromise',
  'const loadHandler = () => handlerPromise ??= import(' + JSON.stringify(deployedEntry) + ')',
  '  .then((module) => {',
  '    if (typeof module.default !== "function") {',
  '      throw Object.assign(new Error("The generated Vercel entry must default-export a request handler."), {',
  '        code: "ERR_VUE_SSR_LITE_INVALID_RUNTIME_EXPORT",',
  '      })',
  '    }',
  '    return module.default',
  '  })',
  '  .catch((error) => { handlerPromise = undefined; throw error })',
  createSsrVercelBootstrapDiagnosticSource(),
  'export default async function vueSsrLiteVercelFunction(request, response) {',
  '  const sendFailure = (errorId) => {',
  '    if (response.headersSent || response.writableEnded || response.destroyed) {',
  '      if (!response.destroyed && !response.writableEnded) response.destroy()',
  '      return',
  '    }',
  '    response.statusCode = 500',
  '    response.setHeader("content-type", "text/plain; charset=utf-8")',
  '    response.setHeader("cache-control", "no-store")',
  '    if (request.method === "HEAD") {',
  '      response.end("")',
  '      return',
  '    }',
  '    const id = typeof errorId === "string" && /^vssl_[a-f0-9]{16}$/.test(errorId) ? errorId : ""',
  '    response.end(id ? "Internal Server Error\\nError ID: " + id : "Internal Server Error")',
  '  }',
  '  let handler',
  '  try {',
  '    handler = await loadHandler()',
  '  } catch (error) {',
  '    sendFailure(reportBootstrapFailure(error))',
  '    return',
  '  }',
  '  try {',
  '    return await handler(request, response)',
  '  } catch (error) {',
  '    sendFailure(reportInvocationFailure(error))',
  '  }',
  '}',
  '',
].join('\n')

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
          `import { createVercelHandler, readVercelRuntimeConfig } from ${JSON.stringify(runtimeEntry())}`,
          'import { fileURLToPath } from "node:url"',
          `const root = fileURLToPath(new URL(${JSON.stringify(modulePath(relative(stage, root)) + '/')}, import.meta.url))`,
          'export default createVercelHandler({ root, loadRuntime: async () => {',
          `  const config = await readVercelRuntimeConfig(await import(${JSON.stringify(runtimeSpecifier)}))`,
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
      console.warn(`[vue-ssr-lite] Dependency tracing reported ${trace.warnings.size} unresolved or optional references.`)
      for (const message of createVercelTraceWarningMessages(trace.warnings)) {
        console.warn(message)
      }
    }
    const deployedProject = modulePath(posix(relative(functionRoot, resolve(payload, relative(payloadRoot, root))))) + '/'
    const deployedEntry = modulePath(posix(relative(functionRoot, resolve(payload, relative(payloadRoot, entry)))))
    await writeFile(
      resolve(functionRoot, 'index.mjs'),
      createVercelFunctionBootstrap(deployedProject, deployedEntry)
    )
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
