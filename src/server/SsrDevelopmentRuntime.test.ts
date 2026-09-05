import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentModuleNode, ViteDevServer } from 'vite'
import { defineComponent, h } from 'vue'
import { withSsrShells } from '../SsrTestFixtures'
import { useSsrRequestContext } from '../SsrRequestContext'
import { importSsrViteModule } from '../vite/SsrViteModuleRuntime'
import { createSsrManagedServer, type SsrManagedServer } from './SsrServerRuntime'

const runnableTestEnvironments = vi.hoisted(() => new WeakSet<object>())

// Vite exports the runnable-environment type and factory, not its constructor.
// Brand only this file's deterministic doubles at the Vite boundary; retain
// the real guard for every other environment and the real runtime/revision code.
vi.mock('vite', async (importOriginal) => {
  const vite = await importOriginal<typeof import('vite')>()
  return {
    ...vite,
    isRunnableDevEnvironment: (environment: Parameters<typeof vite.isRunnableDevEnvironment>[0]) =>
      runnableTestEnvironments.has(environment) || vite.isRunnableDevEnvironment(environment),
  }
})

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const ROOT = '/virtual-runtime.ts'
const dependencies = ['/src/App.vue', '/src/main.ts', '/src/routes.ts', '/application.ts']
let root = ''
let managed: SsrManagedServer | undefined
const releases: (() => void)[] = []

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await managed?.close()
  managed = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
  vi.restoreAllMocks()
})

const createHarness = async (options: { multi?: boolean; debug?: boolean; template?: boolean } = {}) => {
  root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-revisions-'))
  const templatePath = join(root, 'index.html')
  const source = '<html><head></head><body><div id="app"></div></body></html>'
  if (options.template !== false) await writeFile(templatePath, source)
  const state: { revision: string; error?: Error; beforeCompile?: () => Promise<void> } = { revision: 'A' }
  const publicConfig = vi.fn((input: { headers: Record<string, unknown> }) => ({ marker: input.headers['x-marker'] ?? 'none' }))
  const debug = vi.fn()
  const logger = { error: vi.fn(), ...(options.debug ? { debug } : {}) }
  const statesSeen = new WeakSet<object>()
  const applicationIds = options.multi ? ['alpha', 'beta'] : ['app']
  const makeConfig = (revision: string) => withSsrShells({
    server: { port: 0, diagnostics: true, logger },
    ...(options.multi ? {
      applications: applicationIds.map((name) => ({
        name, host: `${name}.test`, publicConfig,
        cookies: { allow: [name] },
        createInitialState: () => ({ visits: 0 }),
      })),
    } : { publicConfig, createInitialState: () => ({ visits: 0 }) }),
  }, Object.fromEntries(applicationIds.map((id) => [id, {
    root: defineComponent({ setup() {
      const context = useSsrRequestContext<{ visits: number }, { marker: string }>()
      const visits = statesSeen.has(context.state) ? 'shared' : 1
      statesSeen.add(context.state)
      return () => h('main', `${id}:${revision}:${context.publicConfig.marker}:${visits}:${context.request.cookie ?? ''}`)
    } }),
  }])))
  const factory = vi.fn(async () => {
    const { revision, error, beforeCompile } = state
    await beforeCompile?.()
    if (error) throw error
    return makeConfig(revision)
  })
  let namespace: { default: () => unknown } = { default: factory }

  // Deterministically control Vite's public graph/evaluation boundary. The
  // managed server, config compiler, request handler, and Vue renderer are real.
  // A separate integration test exercises the actual Vite watcher and runner.
  const nodes = new Map([ROOT, ...dependencies].map((id) => [id, {
    id, url: id, file: id, importedModules: new Set<EnvironmentModuleNode>(),
    lastInvalidationTimestamp: 0, lastHMRTimestamp: 0,
  } as EnvironmentModuleNode]))
  for (const id of dependencies) nodes.get(ROOT)!.importedModules.add(nodes.get(id)!)
  const evaluations = new Map([[ROOT, { id: ROOT, exports: namespace }]])
  const evaluatedModules = {
    idToModuleMap: evaluations,
    getModuleById: (id: string) => evaluations.get(id),
    getModuleByUrl: (id: string) => id === ROOT ? { id: ROOT } : undefined,
  }
  const runner = { evaluatedModules, import: vi.fn(async () => namespace) }
  const ssr = {
    runner,
    moduleGraph: {
      getModuleById: (id: string) => nodes.get(id),
      getModuleByUrl: async (id: string) => nodes.get(id),
    },
  }
  runnableTestEnvironments.add(ssr)
  const watcher = Object.assign(new EventEmitter(), { add: vi.fn() })
  const transform = vi.fn(async (_url: string, html: string, originalUrl: string) =>
    html.replace('</head>', `<meta name="request-path" content="${originalUrl}"></head>`)
  )
  const vite = {
    config: { root, base: '/' }, watcher,
    environments: { ssr, client: { transformRequest: async () => null } },
    middlewares: (_request: unknown, _response: unknown, next: () => void) => next(),
    transformIndexHtml: transform,
    close: vi.fn(async () => undefined),
  } as unknown as ViteDevServer
  const loadRuntime = vi.fn(() => importSsrViteModule(vite, ROOT))
  managed = await createSsrManagedServer({ production: false, root, vite, loadRuntime })
  await managed.listen()
  const get = (path = '/', host = 'localhost', marker = 'none', cookie = '') =>
    new Promise<{ status: number; body: string }>((resolveResponse, rejectResponse) => {
      const req = request({ hostname: '127.0.0.1', port: managed!.address().port, path, agent: false,
        headers: { host, accept: 'text/html', 'x-marker': marker, cookie } }, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { body += chunk })
        response.on('error', rejectResponse)
        response.on('end', () => resolveResponse({ status: response.statusCode!, body }))
      })
      req.on('error', rejectResponse)
      req.end()
    })
  const invalidate = (id = ROOT) => { nodes.get(id)!.lastInvalidationTimestamp += 1 }
  const replaceExports = (revision: string) => {
    namespace = { default: () => makeConfig(revision) }
    evaluations.get(ROOT)!.exports = namespace
  }
  return { state, factory, loadRuntime, publicConfig, logger, debug, nodes, watcher,
    transform, get, invalidate, replaceExports, templatePath, source }
}

describe('managed development runtime revisions', () => {
  it('reuses one compile across unchanged requests without sharing request state or HTML', async () => {
    const harness = await createHarness()
    const first = await harness.get('/first', 'localhost', 'one')
    const second = await harness.get('/second', 'localhost', 'two')
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.body).toContain('app:A:one:1:')
    expect(second.body).toContain('app:A:two:1:')
    expect(first.body).toContain('content="/first"')
    expect(second.body).toContain('content="/second"')
    expect(harness.factory).toHaveBeenCalledTimes(1)
    expect(harness.loadRuntime).toHaveBeenCalledTimes(1)
    expect(harness.publicConfig).toHaveBeenCalledTimes(2)
    expect(harness.transform).toHaveBeenCalledTimes(2)
  })

  it.each([ROOT, ...dependencies])('refreshes when Vite invalidates %s', async (id) => {
    const harness = await createHarness()
    expect((await harness.get()).body).toContain('app:A:')
    harness.state.revision = 'B'
    harness.invalidate(id)
    const response = await harness.get()
    expect(response.body).toContain('app:B:')
    expect(harness.factory).toHaveBeenCalledTimes(2)
    if (id !== ROOT) expect(harness.nodes.get(ROOT)!.lastInvalidationTimestamp).toBe(0)
  })

  it('observes replaced ModuleRunner exports even without an entry timestamp change', async () => {
    const harness = await createHarness()
    harness.replaceExports('replacement')
    expect((await harness.get()).body).toContain('app:replacement:')
    expect(harness.loadRuntime).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight refresh between concurrent requests', async () => {
    const harness = await createHarness()
    const entered = deferred()
    const gate = deferred()
    releases.push(() => gate.resolve())
    harness.state.beforeCompile = async () => { entered.resolve(); await gate.promise }
    harness.state.revision = 'B'
    harness.invalidate()
    const requests = Promise.all(Array.from({ length: 8 }, (_, index) => harness.get(`/${index}`)))
    await entered.promise
    expect(harness.factory).toHaveBeenCalledTimes(2)
    gate.resolve()
    for (const response of await requests) expect(response.body).toContain('app:B:')
    expect(harness.factory).toHaveBeenCalledTimes(2)
  })

  it('does not publish a revision invalidated while its factory is awaiting work', async () => {
    const harness = await createHarness()
    const entered = deferred()
    const gate = deferred()
    releases.push(() => gate.resolve())
    harness.state.beforeCompile = async () => { entered.resolve(); await gate.promise }
    harness.state.revision = 'superseded'
    harness.invalidate()
    const pending = harness.get()
    await entered.promise
    harness.state.beforeCompile = undefined
    harness.state.revision = 'current'
    harness.invalidate('/src/main.ts')
    gate.resolve()
    const response = await pending
    expect(response.body).toContain('app:current:')
    expect(response.body).not.toContain('superseded')
    expect(harness.factory).toHaveBeenCalledTimes(3)
    await harness.get()
    expect(harness.factory).toHaveBeenCalledTimes(3)
  })

  it('serves the last good definition after a failed refresh and recovers on the next invalidation', async () => {
    const harness = await createHarness()
    harness.state.error = new Error('invalid application configuration')
    harness.invalidate('/application.ts')
    expect((await harness.get()).body).toContain('app:A:')
    expect((await harness.get()).body).toContain('app:A:')
    expect(harness.factory).toHaveBeenCalledTimes(2)
    expect(harness.logger.error).toHaveBeenCalledWith('ssr.runtime.reload.failed', expect.any(Object))
    harness.state.error = undefined
    harness.state.revision = 'recovered'
    harness.invalidate('/application.ts')
    expect((await harness.get()).body).toContain('app:recovered:')
    expect(harness.factory).toHaveBeenCalledTimes(3)
  })

  it('does not let a late failure mask a newer valid invalidation', async () => {
    const harness = await createHarness()
    const entered = deferred()
    const gate = deferred()
    releases.push(() => gate.resolve())
    harness.state.error = new Error('old invalid config')
    harness.state.beforeCompile = async () => { entered.resolve(); await gate.promise }
    harness.invalidate()
    const pending = harness.get()
    await entered.promise
    harness.state.error = undefined
    harness.state.beforeCompile = undefined
    harness.state.revision = 'repaired'
    harness.invalidate()
    gate.resolve()
    expect((await pending).body).toContain('app:repaired:')
    expect(harness.factory).toHaveBeenCalledTimes(3)
  })

  it('refreshes template existence on add/unlink and reads content changes without compiling again', async () => {
    const harness = await createHarness({ template: false })
    expect((await harness.get()).status).toBe(200)
    await writeFile(harness.templatePath, harness.source.replace('<head>', '<head><meta name="fixture-template" content="created">'))
    harness.watcher.emit('add', harness.templatePath)
    expect((await harness.get()).body).toContain('name="fixture-template" content="created"')
    expect(harness.factory).toHaveBeenCalledTimes(2)
    await writeFile(harness.templatePath, harness.source.replace('<head>', '<head><meta name="fixture-template" content="edited">'))
    harness.watcher.emit('change', harness.templatePath)
    expect((await harness.get()).body).toContain('name="fixture-template" content="edited"')
    expect(harness.factory).toHaveBeenCalledTimes(2)
    await rm(harness.templatePath)
    harness.watcher.emit('unlink', harness.templatePath)
    const fallback = await harness.get()
    expect(fallback.status).toBe(200)
    expect(fallback.body).not.toContain('name="fixture-template" content="edited"')
    expect(harness.factory).toHaveBeenCalledTimes(3)
    await managed!.close()
    expect(harness.watcher.listenerCount('add')).toBe(0)
    expect(harness.watcher.listenerCount('unlink')).toBe(0)
  })

  it('keeps host, cookie, public config, and Vue state isolated across applications and revisions', async () => {
    const harness = await createHarness({ multi: true })
    const [alpha, beta] = await Promise.all([
      harness.get('/', 'alpha.test', 'one', 'alpha=a; beta=b'),
      harness.get('/', 'beta.test', 'two', 'alpha=a; beta=b'),
    ])
    expect(alpha.body).toContain('alpha:A:one:1:alpha=a')
    expect(beta.body).toContain('beta:A:two:1:beta=b')
    expect(harness.factory).toHaveBeenCalledTimes(1)
    harness.state.revision = 'B'
    harness.invalidate('/application.ts')
    expect((await harness.get('/', 'alpha.test', 'three')).body).toContain('alpha:B:three:1:')
    expect((await harness.get('/', 'beta.test', 'four')).body).toContain('beta:B:four:1:')
    expect(harness.factory).toHaveBeenCalledTimes(2)
  })

  it('stays quiet without a debug logger and reports startup separately from first and warm SSR', async () => {
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const quiet = await createHarness()
    await quiet.get()
    expect(consoleDebug).not.toHaveBeenCalled()
    await managed!.close()
    await rm(root, { recursive: true, force: true })
    const harness = await createHarness({ debug: true })
    await harness.get('/first')
    await harness.get('/warm')
    const traces = harness.debug.mock.calls.filter(([event]) => event === 'ssr.diagnostic.timing')
    expect(traces.map(([, details]) => details.lifecycle)).toEqual(['startup', 'first-ssr', 'warm-ssr'])
    expect(traces[1][1]).toMatchObject({ readyToRequestMs: expect.any(Number), phases: {
      'template read': expect.any(Number), 'Vite HTML hooks': expect.any(Number),
      'template preparation': expect.any(Number), total: expect.any(Number),
    } })
    expect(consoleDebug).not.toHaveBeenCalled()
  })
})
