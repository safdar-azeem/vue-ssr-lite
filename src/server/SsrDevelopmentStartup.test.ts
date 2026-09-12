import { EventEmitter } from 'node:events'
import { createServer, type AddressInfo } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentModuleNode, ViteDevServer } from 'vite'
import { defineComponent, h } from 'vue'
import { withSsrShells } from '../SsrTestFixtures'
import { resolveSsrDevelopmentControlPlaneFromRoot } from '../SsrConfigCompileRuntime'
import { attachSsrViteResolvedConfigPath } from '../vite/SsrViteResolvedConfigPath'
import { importSsrViteModule } from '../vite/SsrViteModuleRuntime'
import { createSsrManagedServer, type SsrManagedServer } from './SsrServerRuntime'

const runnableTestEnvironments = vi.hoisted(() => new WeakSet<object>())

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
const HOME_HERO = '/src/modules/Public/components/HomeHero.vue'
const HERO_SOURCE = 'src/modules/Public/components/HomeHero.vue'
const dependencies = ['/src/App.vue', '/src/main.ts', HOME_HERO]

const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '')

const terminalText = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n')

const developmentErrors = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls
    .map((args) => stripAnsi(String(args[0] ?? '')))
    .filter((text) => text.trimStart().startsWith('ERROR:') || text.includes('✓ Application recovered'))
    .map((text) => text.trimStart().startsWith('ERROR:') ? text.trimStart() : text)
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

const viteStyleError = (file = HERO_SOURCE) =>
  Object.assign(new SyntaxError('Single file component can contain only one <template> element'), {
    plugin: 'vite:vue',
    id: file,
    loc: { file, line: 10, column: 1 },
    frame: '  8 | <template>\n  9 | <template>\n    | ^',
    stack:
      'SyntaxError: Single file component can contain only one <template> element\n    at createError (/plugin-vue)',
  })

const writeWebsiteApplicationGraph = async (
  projectRoot: string,
  options: { host: string; port: number; configFile?: string }
) => {
  await mkdir(join(projectRoot, 'node_modules/vue-ssr-lite'), { recursive: true })
  await mkdir(join(projectRoot, 'src/modules/website'), { recursive: true })
  await writeFile(
    join(projectRoot, 'node_modules/vue-ssr-lite/package.json'),
    '{"name":"vue-ssr-lite","type":"module","exports":"./index.js"}\n'
  )
  await writeFile(
    join(projectRoot, 'node_modules/vue-ssr-lite/index.js'),
    'export const defineApplication = (config) => config\n'
  )
  await writeFile(
    join(projectRoot, 'src/modules/website/Home.vue'),
    '<template><div>home</div></template>\n<template><div>duplicate</div></template>\n'
  )
  await writeFile(
    join(projectRoot, 'src/modules/website/routes.ts'),
    `import Home from './Home.vue'\nexport default [{ path: '/', component: Home }]\n`
  )
  await writeFile(
    join(projectRoot, 'src/modules/website/app.ts'),
    [
      "import { defineApplication } from 'vue-ssr-lite'",
      "import routes from './routes'",
      "export default defineApplication({ name: 'website', routes })",
      '',
    ].join('\n')
  )
  const configFile = options.configFile ?? join(projectRoot, 'server.ts')
  await mkdir(dirname(configFile), { recursive: true })
  const applicationSpecifier = relative(
    dirname(configFile),
    join(projectRoot, 'src/modules/website/app')
  ).replaceAll('\\', '/')
  await writeFile(
    configFile,
    [
      `import website from '${applicationSpecifier.startsWith('.') ? applicationSpecifier : `./${applicationSpecifier}`}'`,
      'export default {',
      `  server: { host: ${JSON.stringify(options.host)}, port: ${options.port}, diagnostics: true },`,
      '  applications: [website],',
      '}',
      '',
    ].join('\n')
  )
}

const createHarness = async (options: {
  listen?: boolean
  initialError?: Error
  host?: string
  port?: number
  websiteGraph?: boolean
  configFile?: string
  decoyServer?: string
  /** When false, managed options omit `config` so only the Vite-selected path is used. */
  passManagedConfig?: boolean
} = {}) => {
  root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-startup-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(
    join(root, 'index.html'),
    '<html><head></head><body><div id="app"></div></body></html>'
  )
  await writeFile(join(root, 'src/main.ts'), 'export default () => {}\n')
  await writeFile(join(root, 'src/App.vue'), '<template><div /></template>\n')
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 0
  const selectedConfig = options.configFile ? resolve(root, options.configFile) : undefined
  if (options.websiteGraph) {
    await writeWebsiteApplicationGraph(root, { host, port, configFile: selectedConfig })
  } else if (selectedConfig) {
    await mkdir(dirname(selectedConfig), { recursive: true })
    await writeFile(
      selectedConfig,
      [
        'export default {',
        '  server: {',
        `    host: ${JSON.stringify(host)},`,
        `    port: ${port},`,
        '    diagnostics: true,',
        '  },',
        '}',
        '',
      ].join('\n')
    )
  } else {
    await writeFile(
      join(root, 'server.ts'),
      [
        'export default {',
        '  server: {',
        `    host: ${JSON.stringify(host)},`,
        `    port: ${port},`,
        '    diagnostics: true,',
        '  },',
        '}',
        '',
      ].join('\n')
    )
  }
  if (options.decoyServer) {
    await writeFile(join(root, 'server.ts'), options.decoyServer)
  }
  const state: { revision: string; error?: Error; beforeCompile?: () => Promise<void> } = {
    revision: 'A',
    error: options.initialError,
  }
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
  const makeConfig = (revision: string) => withSsrShells({
    server: {
      port: options.port ?? 0,
      host: options.host,
      diagnostics: true,
      logger,
    },
    createInitialState: () => ({ visits: 0 }),
  }, {
    app: {
      root: defineComponent({
        setup: () => () => h('main', `app:${revision}`),
      }),
    },
  })
  const factory = vi.fn(async () => {
    const { revision, error, beforeCompile } = state
    await beforeCompile?.()
    if (error) throw error
    return makeConfig(revision)
  })
  let namespace: { default: () => unknown } = { default: factory }
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
  const runner = {
    evaluatedModules,
    import: vi.fn(async () => namespace),
  }
  const ssr = {
    runner,
    moduleGraph: {
      getModuleById: (id: string) => nodes.get(id),
      getModuleByUrl: async (id: string) => nodes.get(id),
    },
  }
  runnableTestEnvironments.add(ssr)
  const watcher = Object.assign(new EventEmitter(), { add: vi.fn() })
  const viteClose = vi.fn(async () => undefined)
  const vite = {
    config: { root, base: '/' },
    watcher,
    environments: { ssr, client: { transformRequest: async () => null } },
    middlewares: (
      incoming: { url?: string },
      response: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body?: string) => void },
      next: () => void
    ) => {
      const url = incoming.url || ''
      if (
        url.startsWith('/@vite/') ||
        url.startsWith('/@id/') ||
        url.startsWith('/@fs/') ||
        url.startsWith('/src/') ||
        url.startsWith('/@vue-ssr-lite/client/')
      ) {
        response.statusCode = 200
        response.setHeader('content-type', 'text/javascript')
        response.end('/* vite */')
        return
      }
      next()
    },
    transformIndexHtml: async (_url: string, html: string) => html,
    close: viteClose,
  } as unknown as ViteDevServer
  const loadRuntime = vi.fn(() => importSsrViteModule(vite, ROOT))
  if (selectedConfig) attachSsrViteResolvedConfigPath(vite, selectedConfig)
  managed = await createSsrManagedServer({
    production: false,
    root,
    ...(options.passManagedConfig === false ? {} : { config: selectedConfig }),
    vite,
    loadRuntime,
  })
  if (options.listen !== false) await managed.listen()
  const exchange = (
    path: string,
    method: 'GET' | 'HEAD' = 'GET',
    headers: Record<string, string> = {}
  ) =>
    new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>(
      (resolveResponse, rejectResponse) => {
        const req = request({
          hostname: '127.0.0.1',
          port: managed!.address().port,
          path,
          method,
          agent: false,
          headers: { accept: 'text/html', ...headers },
        }, (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk) => { body += chunk })
          response.on('error', rejectResponse)
          response.on('end', () => resolveResponse({
            status: response.statusCode!,
            body,
            headers: response.headers,
          }))
        })
        req.on('error', rejectResponse)
        req.end()
      }
    )
  const invalidate = (id = ROOT) => { nodes.get(id)!.lastInvalidationTimestamp += 1 }
  return {
    state,
    factory,
    loadRuntime,
    logger,
    watcher,
    viteClose,
    get: (path = '/') => exchange(path),
    head: (path = '/') => exchange(path, 'HEAD'),
    invalidate,
  }
}

describe('development startup with a broken application runtime', () => {
  it('keeps the listener alive and serves the development error page', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const harness = await createHarness({ initialError: viteStyleError() })
    expect(managed!.address().host).toBe('127.0.0.1')
    const first = await harness.get('/')
    const second = await harness.get('/')
    await harness.get('/')
    expect(first.status).toBe(500)
    expect(second.status).toBe(500)
    expect(first.headers['content-type']).toMatch(/text\/html/)
    expect(first.headers['cache-control']).toBe('no-store')
    expect(first.body).toContain('background:#000')
    expect(first.body).toContain('Application error')
    expect(first.body).toContain('vite:vue · SyntaxError')
    expect(first.body).not.toContain('[plugin:vite:vue]')
    expect(first.body).toContain('Single file component can contain only one <template> element')
    expect(first.body).toContain(`${HERO_SOURCE}:10:1`)
    expect(first.body).toContain('__open-in-editor?file=')
    expect(first.body).toContain('data-ssr-open-source')
    expect(first.body).not.toContain('vscode:')
    expect(first.body).toContain('Request: /')
    expect(first.body).toMatch(/Error ID: vssl_[a-f0-9]{16}/)
    expect(first.body).toContain('<details>')
    expect(first.body).not.toContain('<details open')
    expect(first.body).not.toContain('Open in VS Code')
    expect(harness.factory).toHaveBeenCalledTimes(1)
    expect(harness.loadRuntime).toHaveBeenCalledTimes(1)
    expect(developmentErrors(consoleLog)).toEqual([
      [
        'ERROR: Single file component can contain only one <template> element',
        'Plugin: vite:vue',
        `File: ${HERO_SOURCE}:10:1`,
      ].join('\n'),
    ])
    expect(consoleLog.mock.calls.some(([text]) => stripAnsi(String(text)).startsWith('\nERROR:'))).toBe(true)
    expect(terminalText(consoleError)).not.toContain('[vue-ssr-lite]')
    expect(terminalText(consoleLog)).not.toContain('ssr.runtime.unavailable')
    expect(terminalText(consoleLog)).not.toContain('Application runtime unavailable')
    expect(terminalText(consoleLog)).not.toContain('ssr.request.failed')
  })

  it('recovers on the next Vite revision without restarting the listener', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const harness = await createHarness({ initialError: viteStyleError() })
    const port = managed!.address().port
    expect((await harness.get('/')).status).toBe(500)
    harness.state.error = undefined
    harness.state.revision = 'recovered'
    harness.invalidate(HOME_HERO)
    const recovered = await harness.get('/')
    expect(managed!.address().port).toBe(port)
    expect(recovered.status).toBe(200)
    expect(recovered.body).toContain('app:recovered')
    expect(recovered.body).not.toContain('Application error')
    expect(harness.factory).toHaveBeenCalledTimes(2)
    expect(developmentErrors(consoleLog).filter((text) => text === '✓ Application recovered')).toEqual([
      '✓ Application recovered',
    ])
  })

  it('does not reprint the same compiler failure across HMR reloads or later requests', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const error = viteStyleError()
    const harness = await createHarness({ initialError: error })
    await harness.get('/')
    harness.state.error = error
    harness.invalidate(HOME_HERO)
    await harness.get('/')
    await harness.get('/')
    expect(developmentErrors(consoleLog)).toEqual([
      [
        'ERROR: Single file component can contain only one <template> element',
        'Plugin: vite:vue',
        `File: ${HERO_SOURCE}:10:1`,
      ].join('\n'),
    ])
  })

  it('does not print recovery for a successful ready-to-ready HMR update', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const harness = await createHarness()
    expect((await harness.get('/')).status).toBe(200)
    harness.state.revision = 'warm'
    harness.invalidate()
    expect((await harness.get('/')).body).toContain('app:warm')
    expect(developmentErrors(consoleLog)).toEqual([])
  })

  it('still delivers structured events to a custom development logger', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const harness = await createHarness()
    expect((await harness.get('/')).status).toBe(200)
    const next = viteStyleError()
    harness.state.error = next
    harness.invalidate()
    expect((await harness.get('/')).status).toBe(200)
    expect(harness.logger.error).toHaveBeenCalledWith(
      'ssr.runtime.reload.failed',
      expect.objectContaining({
        errorType: 'SyntaxError',
        message: expect.stringContaining('only one <template>'),
      })
    )
    expect(developmentErrors(consoleLog)).toEqual([
      [
        'ERROR: Single file component can contain only one <template> element',
        'Plugin: vite:vue',
        `File: ${HERO_SOURCE}:10:1`,
      ].join('\n'),
    ])
    expect(terminalText(consoleError)).not.toContain('[vue-ssr-lite]')
  })

  it('keeps serving the latest failure until a later revision succeeds', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const harness = await createHarness({ initialError: viteStyleError() })
    expect((await harness.get('/')).status).toBe(500)
    harness.state.error = new Error('revision B still invalid')
    harness.invalidate()
    const second = await harness.get('/')
    expect(second.status).toBe(500)
    expect(second.body).toContain('revision B still invalid')
    expect(harness.factory).toHaveBeenCalledTimes(2)
    expect(developmentErrors(consoleLog)).toEqual([
      [
        'ERROR: Single file component can contain only one <template> element',
        'Plugin: vite:vue',
        `File: ${HERO_SOURCE}:10:1`,
      ].join('\n'),
      'ERROR: revision B still invalid',
    ])
    harness.state.error = undefined
    harness.state.revision = 'C'
    harness.invalidate()
    const recovered = await harness.get('/')
    expect(recovered.status).toBe(200)
    expect(recovered.body).toContain('app:C')
    expect(harness.factory).toHaveBeenCalledTimes(3)
    expect(developmentErrors(consoleLog).filter((text) => text === '✓ Application recovered')).toEqual([
      '✓ Application recovered',
    ])
    await harness.get('/')
    expect(developmentErrors(consoleLog).filter((text) => text === '✓ Application recovered')).toHaveLength(1)
  })

  it('does not let a late failed revision overwrite a newer recovered runtime', async () => {
    const harness = await createHarness({ initialError: viteStyleError() })
    expect((await harness.get('/')).status).toBe(500)
    const entered = deferred()
    const gate = deferred()
    releases.push(() => gate.resolve())
    harness.state.error = new Error('revision B still invalid')
    harness.state.beforeCompile = async () => { entered.resolve(); await gate.promise }
    harness.invalidate()
    const pending = harness.get('/')
    await entered.promise
    harness.state.error = undefined
    harness.state.beforeCompile = undefined
    harness.state.revision = 'C'
    harness.invalidate()
    gate.resolve()
    const recovered = await pending
    expect(recovered.status).toBe(200)
    expect(recovered.body).toContain('app:C')
    expect((await harness.get('/')).body).toContain('app:C')
    expect(harness.factory).toHaveBeenCalledTimes(3)
  })

  it('keeps Vite-owned module requests out of the application error document', async () => {
    const harness = await createHarness({ initialError: viteStyleError() })
    const owned = await harness.get('/@vite/client')
    expect(owned.status).toBe(200)
    expect(owned.body).toBe('/* vite */')
    expect(owned.body).not.toContain('Application error')
    expect((await harness.get('/src/main.ts')).body).toBe('/* vite */')
    expect((await harness.get('/@vue-ssr-lite/client/app')).body).toBe('/* vite */')
  })

  it('returns a bodyless HEAD response for the initial runtime failure', async () => {
    const harness = await createHarness({ initialError: viteStyleError() })
    const head = await harness.head('/')
    expect(head.status).toBe(500)
    expect(head.body).toBe('')
    expect(head.headers['content-type']).toMatch(/text\/html/)
    expect(head.headers['cache-control']).toBe('no-store')
  })

  it('uses configured listen options when server.ts imports a broken application graph', async () => {
    const harness = await createHarness({ initialError: viteStyleError(), websiteGraph: true })
    const plane = await resolveSsrDevelopmentControlPlaneFromRoot(root)
    expect(plane.host).toBe('127.0.0.1')
    expect(plane.port).toBe(0)
    expect(managed!.address().host).toBe('127.0.0.1')
    const port = managed!.address().port
    expect(port).toBeGreaterThan(0)
    const failed = await harness.get('/')
    expect(failed.status).toBe(500)
    expect(failed.body).toContain('Application error')
    expect(failed.body).toContain('vite:vue · SyntaxError')
    expect(failed.body).toContain(`${HERO_SOURCE}:10:1`)
    harness.state.error = undefined
    harness.state.revision = 'recovered'
    harness.invalidate(HOME_HERO)
    const recovered = await harness.get('/')
    expect(managed!.address().port).toBe(port)
    expect(recovered.status).toBe(200)
    expect(recovered.body).toContain('app:recovered')
  })

  it('uses an explicit custom config path for failed-startup listen options', async () => {
    const harness = await createHarness({
      initialError: viteStyleError(),
      websiteGraph: true,
      configFile: 'config/platform.ts',
      passManagedConfig: false,
    })
    const discovered = await resolveSsrDevelopmentControlPlaneFromRoot(root)
    expect(discovered.host).toBe('0.0.0.0')
    expect(managed!.address().host).toBe('127.0.0.1')
    const port = managed!.address().port
    expect(port).toBeGreaterThan(0)
    expect(port).not.toBe(4173)
    const failed = await harness.get('/')
    expect(failed.status).toBe(500)
    expect(failed.body).toContain('Application error')
    expect(failed.body).toContain('vite:vue · SyntaxError')
    expect(failed.body).toContain(`${HERO_SOURCE}:10:1`)
    harness.state.error = undefined
    harness.state.revision = 'recovered'
    harness.invalidate(HOME_HERO)
    const recovered = await harness.get('/')
    expect(managed!.address().port).toBe(port)
    expect(recovered.status).toBe(200)
    expect(recovered.body).toContain('app:recovered')
  })

  it('prefers the Vite-selected config path over a conventional server.ts', async () => {
    const harness = await createHarness({
      initialError: viteStyleError(),
      websiteGraph: true,
      configFile: 'config/platform.ts',
      passManagedConfig: false,
      decoyServer: 'export default { server: { host: "0.0.0.0", port: 4173, diagnostics: true } }\n',
    })
    const discovered = await resolveSsrDevelopmentControlPlaneFromRoot(root)
    expect(discovered.host).toBe('0.0.0.0')
    expect(discovered.port).toBe(4173)
    expect(managed!.address().host).toBe('127.0.0.1')
    expect(managed!.address().port).not.toBe(4173)
    expect((await harness.get('/')).status).toBe(500)
  })

  it('still fails production startup when the initial runtime cannot load', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-startup-prod-'))
    await expect(createSsrManagedServer({
      production: true,
      root,
      loadRuntime: async () => { throw viteStyleError() },
    })).rejects.toMatchObject({
      message: 'Single file component can contain only one <template> element',
    })
  })

  it('still rejects listen when the configured development port is already bound', async () => {
    const blocker = createServer()
    await new Promise<void>((resolveListen, rejectListen) => {
      blocker.once('error', rejectListen)
      blocker.listen(0, '127.0.0.1', () => resolveListen())
    })
    const port = (blocker.address() as AddressInfo).port
    try {
      const harness = await createHarness({
        listen: false,
        initialError: viteStyleError(),
        host: '127.0.0.1',
        port,
      })
      await expect(managed!.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(harness.factory).toHaveBeenCalledTimes(1)
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        blocker.close((error) => error ? rejectClose(error) : resolveClose())
      })
    }
  })

  it('uses the managed-server config option when Vite has not published a path', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-startup-cli-config-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'config'), { recursive: true })
    await writeFile(join(root, 'src/main.ts'), 'export default () => {}\n')
    await writeFile(join(root, 'src/App.vue'), '<template><div /></template>\n')
    await writeFile(
      join(root, 'config/platform.ts'),
      'export default { server: { host: "127.0.0.1", port: 0, diagnostics: true } }\n'
    )
    managed = await createSsrManagedServer({
      production: false,
      root,
      config: join(root, 'config/platform.ts'),
      loadRuntime: async () => { throw viteStyleError() },
    })
    await managed.listen()
    expect(managed.address().host).toBe('127.0.0.1')
    expect(managed.address().port).toBeGreaterThan(0)
  })

  it('does not fall through to server.ts when an explicit custom config is invalid', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-startup-custom-invalid-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'config'), { recursive: true })
    await writeFile(join(root, 'src/main.ts'), 'export default () => {}\n')
    await writeFile(join(root, 'src/App.vue'), '<template><div /></template>\n')
    await writeFile(
      join(root, 'server.ts'),
      'export default { server: { host: "127.0.0.1", port: 0 } }\n'
    )
    await writeFile(
      join(root, 'config/platform.ts'),
      'export default { server: { host: "127.0.0.1", port: 4211, maxConcurrentSsrRequests: 0 } }\n'
    )
    await expect(createSsrManagedServer({
      production: false,
      root,
      config: join(root, 'config/platform.ts'),
      loadRuntime: async () => { throw viteStyleError() },
    })).rejects.toThrow('server.maxConcurrentSsrRequests must be a finite positive integer.')
  })

  it('does not start development with default listen options when the control plane is invalid', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-startup-control-plane-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src/main.ts'), 'export default () => {}\n')
    await writeFile(join(root, 'src/App.vue'), '<template><div /></template>\n')
    await writeFile(
      join(root, 'server.ts'),
      'export default { server: { host: "127.0.0.1", port: 4211, maxConcurrentSsrRequests: 0 } }\n'
    )
    await expect(createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => { throw viteStyleError() },
    })).rejects.toThrow('server.maxConcurrentSsrRequests must be a finite positive integer.')
  })

  it('does not start development with default listen options when server.ts uses an unsupported routes projection', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-startup-routes-'))
    await writeFile(
      join(root, 'server.ts'),
      "export default { server: { host: '127.0.0.1', port: 4211 }, routes: [{ path: '/' }] }\n"
    )
    await expect(createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => { throw viteStyleError() },
    })).rejects.toThrow(/defineServer\(\{ routes \}\) is not supported/)
  })

  it('does not start development with default listen options when server.ts is not a config object', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-startup-export-'))
    await writeFile(join(root, 'server.ts'), "export default 'not-a-config'\n")
    await expect(createSsrManagedServer({
      production: false,
      root,
      loadRuntime: async () => { throw viteStyleError() },
    })).rejects.toThrow('The server.ts module must export an object.')
  })

  it('closes watcher and Vite resources once from the failed-runtime state', async () => {
    const harness = await createHarness({ initialError: viteStyleError() })
    expect((await harness.get('/')).status).toBe(500)
    await managed!.close()
    await managed!.close()
    expect(harness.watcher.listenerCount('add')).toBe(0)
    expect(harness.watcher.listenerCount('unlink')).toBe(0)
    expect(harness.viteClose).toHaveBeenCalledTimes(1)
    managed = undefined
  })
})
