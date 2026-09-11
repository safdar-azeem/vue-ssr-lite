import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join, parse, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { nodeFileTrace } from '@vercel/nft'
import {
  buildVercelDeployment,
  createVercelFunctionBootstrap,
  createVercelRouting,
  createVercelTraceWarningMessages,
} from '../vercel/VercelBuild'
import { deploymentFiles } from '../DeploymentAssets'
import { DEPLOYMENT_METADATA_PATH } from '../DeploymentMetadata'

// Projection tests exercise filesystem/routing assembly without invoking a
// compiler or repeating Vite's consumer-build test suite.
vi.mock('esbuild', () => ({ build: vi.fn() }))
vi.mock('@vercel/nft', () => ({ nodeFileTrace: vi.fn() }))

const execFileAsync = promisify(execFile)

const NATIVE_BOOTSTRAP_DRIVER = `
const logs = []
console.error = (...args) => {
  logs.push(args.map((value) => typeof value === 'string' ? value : String(value)).join(' '))
}
const createResponse = () => {
  const headers = Object.create(null)
  return {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    body: undefined,
    setHeader(name, value) { headers[name] = value },
    getHeader(name) { return headers[name] },
    writeHead(status) { this.statusCode = status; this.headersSent = true },
    end(body = '') { this.body = body; this.writableEnded = true },
    destroy() { this.destroyed = true },
    headers,
  }
}
const bootstrap = await import(process.argv[2])
const method = process.argv[3] || 'GET'
const requestCount = Number(process.argv[4] || 1)
const responses = []
for (let index = 0; index < requestCount; index += 1) {
  const start = logs.length
  const response = createResponse()
  await bootstrap.default({ method }, response)
  responses.push({
    statusCode: response.statusCode,
    body: response.body ?? null,
    headersSent: response.headersSent,
    writableEnded: response.writableEnded,
    destroyed: response.destroyed,
    headers: { ...response.headers },
    logs: logs.slice(start),
  })
}
process.stdout.write(JSON.stringify({ responses }))
`

let root = ''
afterEach(async () => {
  vi.restoreAllMocks()
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
  vi.clearAllMocks()
})

describe('Vercel Build Output API projection', () => {
  it.each([false, true])('preserves Core runtime files and respects CDN ownership with dynamicAssets=%s', async (dynamicAssets) => {
    root = await mkdtemp(join(tmpdir(), 'ssr-vercel-build-'))
    const clientRoot = join(root, 'dist/client')
    const serverOutput = join(root, 'dist/server/SsrRuntime.js')
    const files: Record<string, string> = {
      'package.json': '{"type":"module"}',
      'dist/server/SsrRuntime.js': 'import data from "../client/runtime-shared.json" with { type: "json" }; export default () => ({ data })',
      'dist/server/chunks/lazy.js': 'export const lazy = true',
      'dist/client/index.html': '<div id="app">private template</div>',
      'dist/client/assets/main.js': 'client javascript',
      'dist/client/assets/lazy.js': 'lazy browser chunk',
      'dist/client/assets/main.css': 'body {}',
      'dist/client/images/logo.svg': '<svg/>',
      'dist/client/favicon.ico': 'icon',
      'dist/client/runtime-shared.json': '{"serverReadsThis":true}',
      'dist/client/.vue-ssr-lite/dashboard.html': '<div id="app">dashboard shell</div>',
      'dist/client/robots.txt': 'User-agent: *\nDisallow: /private\n',
      'dist/client/sitemap.xml': '<urlset/>',
      'dist/client/api/owned.js': 'route-owned asset',
      'dist/client/.vite/manifest.json': '{"main":{"file":"assets/main.js"}}',
      'dist/client/.vite/ssr-manifest.json': '{}',
      'dist/client/.vite/vue-ssr-lite-assets.json': '{"version":1,"immutable":["assets/main.js"]}',
      [`dist/client/${DEPLOYMENT_METADATA_PATH}`]: JSON.stringify({
        version: 1, viteBase: '/', templates: ['index.html'], dynamicAssets,
        serverRouteMatchers: ['^/api/owned\\.js$'], controlPaths: ['/healthz', '/readyz'],
      }),
      'node_modules/runtime-dependency/package.json': '{"type":"module"}',
      'node_modules/runtime-dependency/data.bin': 'runtime data',
    }
    for (const [file, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), source)
    }
    vi.mocked(build).mockImplementation(async (options) => {
      await writeFile(options.outfile!, options.stdin!.contents)
      return { errors: [], warnings: [] }
    })
    vi.mocked(nodeFileTrace).mockImplementation(async (entries) => ({
      fileList: new Set([...entries, join(root, 'package.json'),
        join(root, 'dist/client/runtime-shared.json'),
        join(root, 'node_modules/runtime-dependency/package.json'),
        join(root, 'node_modules/runtime-dependency/data.bin'),
      ].map((file) => relative(parse(root).root, file))),
      esmFileList: new Set(), warnings: new Set(), reasons: new Map(),
    }))
    await buildVercelDeployment({ root, clientRoot, serverOutput })
    const output = join(root, '.vercel/output')
    const cdnFiles = ['assets/lazy.js', 'assets/main.css', 'assets/main.js', 'favicon.ico', 'images/logo.svg', 'runtime-shared.json']
    expect(await deploymentFiles(join(output, 'static'))).toEqual(dynamicAssets ? [] : cdnFiles)
    expect(await readFile(serverOutput, 'utf8')).toBe(files['dist/server/SsrRuntime.js'])
    expect(await readFile(join(clientRoot, 'index.html'), 'utf8')).toContain('private template')
    const functionRoot = join(output, 'functions/__vue_ssr_lite.func')
    const payload = await deploymentFiles(join(functionRoot, 'payload'))
    for (const file of [
      'dist/server/SsrRuntime.js', 'dist/server/chunks/lazy.js',
      'dist/client/index.html', 'dist/client/.vue-ssr-lite/dashboard.html',
      'dist/client/.vite/manifest.json', 'dist/client/.vite/ssr-manifest.json',
      'dist/client/.vite/vue-ssr-lite-assets.json', `dist/client/${DEPLOYMENT_METADATA_PATH}`,
      'dist/client/robots.txt', 'dist/client/sitemap.xml', 'dist/client/api/owned.js',
      'node_modules/runtime-dependency/package.json', 'node_modules/runtime-dependency/data.bin',
    ]) {
      expect(payload, file).toContain(file)
      expect(await readFile(join(functionRoot, 'payload', file), 'utf8')).toBe(files[file])
    }
    for (const file of cdnFiles.filter((file) => file !== 'runtime-shared.json')) {
      expect(payload.includes(`dist/client/${file}`), file).toBe(dynamicAssets)
      expect(await readFile(join(clientRoot, file), 'utf8')).toBe(files[`dist/client/${file}`])
    }
    // A real server import still needs its bytes, even if the same file is public.
    expect(payload).toContain('dist/client/runtime-shared.json')
    const config = JSON.parse(await readFile(join(functionRoot, '.vc-config.json'), 'utf8'))
    expect(config).toMatchObject({ handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, supportsResponseStreaming: true })
    const functionEntry = await readFile(join(functionRoot, 'index.mjs'), 'utf8')
    expect(functionEntry).not.toContain(root)
    expect(functionEntry).toContain('let handlerPromise')
    expect(functionEntry).not.toContain('export default (await import')
    expect(await readdir(root)).not.toContain('vercel.json')
    expect(await readdir(join(root, '.vercel'))).not.toContain('vue-ssr-lite-stage')
    expect(vi.mocked(nodeFileTrace).mock.calls[0]![0]).toContain(join(root, 'dist/server/chunks/lazy.js'))
  })

  it('routes known GET/HEAD files to static and every other path/method to Core', () => {
    const config = createVercelRouting([{ file: 'assets/a+b.js', pathname: '/base/assets/a+b.js', cacheControl: 'public, max-age=31536000, immutable', contentType: 'text/javascript' }])
    const staticRoute = config.routes[0]!
    expect('methods' in staticRoute && staticRoute.methods).toEqual(['GET', 'HEAD'])
    expect(new RegExp(staticRoute.src).test('/base/assets/a+b.js')).toBe(true)
    expect(new RegExp(staticRoute.src).test('/base/assets/abxjs')).toBe(false)
    const fallback = config.routes.at(-1)!
    for (const path of ['/', '/about', '/dashboard', '/unknown', '/api/items', '/robots.txt', '/sitemap.xml', '/redirect', '/.vite/manifest.json']) {
      expect(new RegExp(fallback.src).test(path)).toBe(true)
      expect(fallback.dest).toBe('/__vue_ssr_lite')
    }
    expect('methods' in fallback).toBe(false)
  })

  it('reports sanitized, actionable dependency trace warnings', () => {
    const missing = Object.assign(
      new Error("Cannot find module '@scope/runtime-native' from '/private/build/user/project/index.mjs'"),
      { code: 'MODULE_NOT_FOUND' }
    )
    const messages = createVercelTraceWarningMessages(new Set([
      missing,
      new Error('Failed to parse /private/build/user/project/generated.mjs'),
    ]))
    expect(messages).toEqual([
      '[vue-ssr-lite] Dependency tracing warning (parse failure).',
      '[vue-ssr-lite] Dependency tracing warning (unresolved module: @scope/runtime-native).',
    ])
    expect(messages.join('\n')).not.toContain('/private/build')
  })
})

const createResponse = () => {
  const headers = new Map<string, string>()
  return {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    body: undefined as string | undefined,
    setHeader(name: string, value: string) { headers.set(name, value) },
    getHeader(name: string) { return headers.get(name) },
    writeHead(status: number) { this.statusCode = status; this.headersSent = true },
    end(body = '') { this.body = body; this.writableEnded = true },
    destroy() { this.destroyed = true },
  }
}

const importGeneratedBootstrap = async (entrySource: string) => {
  root = await mkdtemp(join(tmpdir(), 'ssr-vercel-bootstrap-'))
  const entry = join(root, 'entry.mjs')
  const bootstrap = join(root, 'index.mjs')
  await writeFile(entry, entrySource)
  await writeFile(bootstrap, createVercelFunctionBootstrap('./', './entry.mjs'))
  const previousCwd = process.cwd()
  try {
    return await import(`${pathToFileURL(bootstrap).href}?test=${Date.now()}-${Math.random()}`) as {
      default: (request: { method: string }, response: ReturnType<typeof createResponse>) => Promise<unknown>
    }
  } finally {
    process.chdir(previousCwd)
  }
}

const invokeNativeGeneratedBootstrap = async (options: {
  entrySource: string
  extraFiles?: Record<string, string>
  method?: string
  requests?: number
}) => {
  root = await mkdtemp(join(tmpdir(), 'ssr-vercel-bootstrap-'))
  for (const [file, source] of Object.entries(options.extraFiles ?? {})) {
    const path = join(root, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, source)
  }
  const bootstrap = join(root, 'index.mjs')
  const driver = join(root, 'invoke-bootstrap.mjs')
  await writeFile(join(root, 'entry.mjs'), options.entrySource)
  await writeFile(bootstrap, createVercelFunctionBootstrap('./', './entry.mjs'))
  await writeFile(driver, NATIVE_BOOTSTRAP_DRIVER)
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  const { stdout } = await execFileAsync(process.execPath, [
    driver,
    pathToFileURL(bootstrap).href,
    options.method ?? 'GET',
    String(options.requests ?? 1),
  ], {
    env,
    timeout: 15000,
    encoding: 'utf8',
  })
  return JSON.parse(stdout) as {
    responses: Array<{
      statusCode: number
      body: string | null
      headers: Record<string, string>
      logs: string[]
    }>
  }
}

describe('generated Vercel function bootstrap', () => {
  it('loads lazily and caches the successfully initialized handler', async () => {
    const key = `__vueSsrLiteBootstrap${Date.now()}${Math.random()}`
    const generated = await importGeneratedBootstrap(`
globalThis[${JSON.stringify(key)}] = (globalThis[${JSON.stringify(key)}] || 0) + 1
export default async (_request, response) => response.end('ok')
`)
    expect((globalThis as Record<string, unknown>)[key]).toBeUndefined()
    const first = createResponse()
    const second = createResponse()
    await generated.default({ method: 'GET' }, first)
    await generated.default({ method: 'GET' }, second)
    expect(first.body).toBe('ok')
    expect(second.body).toBe('ok')
    expect((globalThis as Record<string, unknown>)[key]).toBe(1)
    delete (globalThis as Record<string, unknown>)[key]
  })

  it('evicts the rejected handler load promise', () => {
    const source = createVercelFunctionBootstrap('./', './entry.mjs')
    expect(source).toContain('let handlerPromise')
    expect(source).toContain('handlerPromise ??= import("./entry.mjs")')
    expect(source).toContain(
      '.catch((error) => { handlerPromise = undefined; throw error })'
    )
  })

  it('allows later requests after a loaded handler fails before sending a response', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const generated = await importGeneratedBootstrap(`
let calls = 0
export default async (_request, response) => {
  calls += 1
  if (calls === 1) throw new Error('temporary request failure')
  response.end('recovered')
}
`)
    const failed = createResponse()
    await generated.default({ method: 'GET' }, failed)
    expect(failed.statusCode).toBe(500)
    expect(failed.body).toBe('Internal Server Error')
    expect(error.mock.calls.flat().join(' ')).toContain('Vercel function initialization or invocation failed.')
    expect(error.mock.calls.flat().join(' ')).not.toContain('temporary request failure')

    const recovered = createResponse()
    await generated.default({ method: 'GET' }, recovered)
    expect(recovered.body).toBe('recovered')
    error.mockRestore()
  })

  it('returns a controlled 500 for a malformed default export without leaking details', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const generated = await importGeneratedBootstrap(
      'export default { secret: "/private/build/user/project" }\n'
    )
    const response = createResponse()
    await generated.default({ method: 'HEAD' }, response)
    expect(response.statusCode).toBe(500)
    expect(response.body).toBe('')
    expect(response.getHeader('cache-control')).toBe('no-store')
    expect(response.getHeader('content-type')).toBe('text/plain; charset=utf-8')
    const diagnostic = JSON.parse(String(error.mock.calls.at(-1)![0]))
    expect(diagnostic).toMatchObject({
      event: 'ssr.bootstrap.failed',
      phase: 'runtime-load',
      reason: 'invalid-runtime-export',
    })
    expect(JSON.stringify(diagnostic)).not.toContain('/private/build')
    error.mockRestore()
  })

  it('classifies generated entry module-load failures without leaking loader text', async () => {
    const result = await invokeNativeGeneratedBootstrap({
      extraFiles: { 'dep.mjs': 'export const present = true\n' },
      entrySource: "import { missing } from './dep.mjs'\nexport default async (_request, response) => response.end('ok')\n",
      requests: 2,
    })
    for (const response of result.responses) {
      expect(response.statusCode).toBe(500)
      expect(response.body).toBe('Internal Server Error')
      const diagnostic = JSON.parse(String(response.logs.at(-1)))
      expect(diagnostic).toMatchObject({
        event: 'ssr.bootstrap.failed',
        phase: 'runtime-load',
        errorType: 'SyntaxError',
        reason: 'missing-named-export',
      })
      expect(JSON.stringify(diagnostic)).not.toMatch(/dep\.mjs|does not provide|\/private/)
    }
  })

  it('classifies generated entry syntax errors without leaking source', async () => {
    const result = await invokeNativeGeneratedBootstrap({
      entrySource: 'export default async () => {}\n{{{\n',
      requests: 2,
    })
    for (const response of result.responses) {
      expect(response.statusCode).toBe(500)
      expect(response.body).toBe('Internal Server Error')
      const diagnostic = JSON.parse(String(response.logs.at(-1)))
      expect(diagnostic).toMatchObject({
        event: 'ssr.bootstrap.failed',
        phase: 'runtime-load',
        errorType: 'SyntaxError',
        reason: 'module-syntax-error',
      })
      expect(JSON.stringify(diagnostic)).not.toMatch(/Unexpected token/)
    }
  })

  it('does not write a second response after the loaded handler has started one', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const generated = await importGeneratedBootstrap(`
export default async (_request, response) => {
  response.writeHead(202)
  throw new Error('stream failed')
}
`)
    const response = createResponse()
    const end = vi.spyOn(response, 'end')
    await generated.default({ method: 'GET' }, response)
    expect(response.statusCode).toBe(202)
    expect(end).not.toHaveBeenCalled()
    expect(response.destroyed).toBe(true)
    error.mockRestore()
  })
})
