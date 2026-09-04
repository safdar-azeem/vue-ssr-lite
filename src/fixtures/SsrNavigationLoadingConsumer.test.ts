import {
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { build, createServer, type ViteDevServer } from 'vite'
import { SSR_RUNTIME_VIRTUAL_ID } from '../SsrConfigCompileRuntime'
import { getSsrStateElementId } from '../SsrSerialization'
import { importSsrViteModule } from '../vite/SsrViteModuleRuntime'
import type { SsrManagedServer } from '../server/SsrServerRuntime'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const fixtureSourceRoot = join(
  repositoryRoot,
  'fixtures/navigation-loading-consumer'
)

let devServer: ViteDevServer | undefined
let managedServer: SsrManagedServer | undefined
let workspaceRoot = ''
let fixtureRoot = ''
let linkedPackageRoot = ''
let clientOutDir = ''
let restoreBrowserGlobals: (() => void) | undefined
let dom: JSDOM | undefined

const importDevelopmentRuntime = async (server: ViteDevServer) => {
  const runtime = await importSsrViteModule<{
    default: () => Promise<Record<string, any>>
  }>(server, SSR_RUNTIME_VIRTUAL_ID)
  const config = await runtime.default()
  return {
    ...runtime,
    default: {
      ...config,
      server: { ...config.server, port: 0 },
    },
  }
}

const waitFor = async (
  condition: () => boolean,
  message: string,
  timeout = 2_000
) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(message)
}

const browserExecutable = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)))

interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, any>
  result?: unknown
  error?: { message?: string }
}

const connectCdp = async (url: string) => {
  const socket = new WebSocket(url)
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >()
  const listeners = new Map<string, Set<(params: Record<string, any>) => void>>()
  let sequence = 0

  await new Promise<void>((resolveOpen, reject) => {
    socket.addEventListener('open', () => resolveOpen(), { once: true })
    socket.addEventListener(
      'error',
      () => reject(new Error('Could not connect to the Chromium DevTools endpoint.')),
      { once: true }
    )
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage
    if (message.id !== undefined) {
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      if (message.error) {
        request.reject(new Error(message.error.message ?? 'Unknown CDP error.'))
      } else {
        request.resolve(message.result)
      }
      return
    }
    if (!message.method) return
    for (const listener of listeners.get(message.method) ?? []) {
      listener(message.params ?? {})
    }
  })

  const send = <T = unknown>(
    method: string,
    params: Record<string, unknown> = {}
  ) =>
    new Promise<T>((resolveRequest, reject) => {
      const id = ++sequence
      pending.set(id, { resolve: resolveRequest, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  const on = (method: string, listener: (params: Record<string, any>) => void) => {
    let registered = listeners.get(method)
    if (!registered) {
      registered = new Set()
      listeners.set(method, registered)
    }
    registered.add(listener)
    return () => registered?.delete(listener)
  }
  const once = (method: string) =>
    new Promise<Record<string, any>>((resolveEvent) => {
      const remove = on(method, (params) => {
        remove()
        resolveEvent(params)
      })
    })

  return { socket, send, on, once }
}

const runChromiumNavigationRegression = async (
  executable: string,
  origin: string,
  profileRoot: string
) => {
  let browser: ChildProcess | undefined
  let socket: WebSocket | undefined
  try {
    await mkdir(profileRoot, { recursive: true })
    browser = spawn(
      executable,
      [
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileRoot}`,
        'about:blank',
      ],
      { stdio: 'ignore' }
    )
    const portFile = join(profileRoot, 'DevToolsActivePort')
    await waitFor(
      () => existsSync(portFile),
      'Chromium did not expose its DevTools port.',
      10_000
    )
    const [port] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/)
    const targetResponse = await fetch(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`,
      { method: 'PUT' }
    )
    const target = (await targetResponse.json()) as {
      webSocketDebuggerUrl?: string
    }
    if (!target.webSocketDebuggerUrl) {
      throw new Error('Chromium did not create a debuggable page target.')
    }
    const cdp = await connectCdp(target.webSocketDebuggerUrl)
    socket = cdp.socket
    const browserMessages: string[] = []
    const documentRequests: string[] = []
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'warning' && params.type !== 'error') return
      browserMessages.push(
        (params.args ?? [])
          .map((argument: { value?: unknown; description?: string }) =>
            String(argument.value ?? argument.description ?? '')
          )
          .join(' ')
      )
    })
    cdp.on('Runtime.exceptionThrown', (params) => {
      browserMessages.push(
        String(params.exceptionDetails?.exception?.description ?? 'Browser exception')
      )
    })
    cdp.on('Log.entryAdded', (params) => {
      if (params.entry?.level === 'warning' || params.entry?.level === 'error') {
        browserMessages.push(String(params.entry.text ?? 'Browser log error'))
      }
    })
    cdp.on('Network.requestWillBeSent', (params) => {
      const requestUrl = String(params.request?.url ?? params.documentURL ?? '')
      if (params.type === 'Document' && requestUrl.startsWith(origin)) {
        documentRequests.push(requestUrl)
      }
    })
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('Runtime.enable'),
      cdp.send('Network.enable'),
      cdp.send('Log.enable'),
    ])

    const loaded = cdp.once('Page.loadEventFired')
    await cdp.send('Page.navigate', { url: `${origin}/` })
    await loaded
    const evaluate = async <T>(expression: string): Promise<T> => {
      const response = await cdp.send<{
        result?: { value?: T }
        exceptionDetails?: { text?: string }
      }>('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.text ?? 'Browser evaluation failed.')
      }
      return response.result?.value as T
    }
    const waitForExpression = async (expression: string, message: string) => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (await evaluate<boolean>(expression)) return
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20))
      }
      throw new Error(message)
    }

    await waitForExpression(
      `Boolean(document.querySelector('.home-page')) && !document.getElementById(${JSON.stringify(getSsrStateElementId('app'))})`,
      'Chromium did not hydrate the linked-package Home page.'
    )
    await evaluate(
      `document.cookie = 'single_session=yes; Path=/; SameSite=Lax'`
    )
    const click = async (selector: string) => {
      const prevented = await evaluate<boolean>(
        `(() => {
          const link = document.querySelector(${JSON.stringify(selector)})
          if (!link) return false
          const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
          link.dispatchEvent(event)
          return event.defaultPrevented
        })()`
      )
      if (!prevented) throw new Error(`${selector} did not prevent native navigation.`)
    }
    const noLoading =
      `!document.querySelector('.page-skeleton') && ` +
      `!document.querySelector('.vssl-loading-indicator')`

    await click('.about-link')
    await waitForExpression(
      `Boolean(document.querySelector('.about-page')) && ${noLoading}`,
      'Chromium About navigation did not settle.'
    )
    await click('.dashboard-link')
    await waitForExpression(
      `Boolean(document.querySelector('.page-skeleton'))`,
      'Chromium did not show the slow middleware fallback.'
    )
    await waitForExpression(
      `document.querySelector('.dashboard-page')?.dataset.authRuns === '1' && ` +
        noLoading,
      'Chromium authenticated Dashboard navigation did not settle.'
    )
    await click('.dashboard-nested-link')
    await waitForExpression(
      `Boolean(document.querySelector('.dashboard-nested-page')) && ` +
        `document.querySelector('.dashboard-page')?.dataset.authRuns === '1' && ` +
        noLoading,
      'Chromium nested Dashboard navigation reran parent middleware or left loading active.'
    )
    await click('.about-link')
    await waitForExpression(
      `Boolean(document.querySelector('.about-page')) && ${noLoading}`,
      'Chromium did not return to About.'
    )
    await click('.dashboard-link')
    await waitForExpression(
      `Boolean(document.querySelector('.page-skeleton'))`,
      'Chromium did not show the superseded fallback.'
    )
    await click('.settings-link')
    await waitForExpression(
      `Boolean(document.querySelector('.settings-page')) && ${noLoading}`,
      'Chromium superseding Settings navigation did not settle.'
    )
    await click('.about-link')
    await waitForExpression(
      `Boolean(document.querySelector('.about-page')) && ${noLoading}`,
      'Chromium did not return to About before redirect.'
    )
    await evaluate(
      `document.cookie = 'single_session=; Path=/; Max-Age=0; SameSite=Lax'`
    )
    await click('.dashboard-link')
    await waitForExpression(
      `Boolean(document.querySelector('.login-page')) && ${noLoading}`,
      'Chromium middleware redirect did not settle on Login.'
    )
    await click('.dashboard-link')
    await waitForExpression(
      `Boolean(document.querySelector('.page-skeleton'))`,
      'Chromium did not show loading for the redirect back to current Login.'
    )
    await waitForExpression(
      `location.pathname === '/login' && ` +
        `location.search === '?redirect=/dashboard' && ` +
        `Boolean(document.querySelector('.login-page')) && ${noLoading}`,
      'Chromium redirect back to current Login did not settle loading.'
    )
    await evaluate('history.back()')
    await waitForExpression(
      `Boolean(document.querySelector('.about-page')) && ${noLoading}`,
      'Chromium Back navigation did not settle.'
    )
    await evaluate('history.forward()')
    await waitForExpression(
      `Boolean(document.querySelector('.login-page')) && ${noLoading}`,
      'Chromium Forward navigation did not settle.'
    )
    await click('.about-link')
    await waitForExpression(
      `Boolean(document.querySelector('.about-page')) && ${noLoading}`,
      'Chromium did not return to About before cancellation.'
    )
    await evaluate(
      `(() => {
        const input = document.querySelector('.about-note')
        input.value = 'chromium state'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`
    )
    await click('.cancelled-link')
    await waitForExpression(
      `Boolean(document.querySelector('.page-skeleton'))`,
      'Chromium did not show the cancellation fallback.'
    )
    await waitForExpression(
      `Boolean(document.querySelector('.about-page')) && ` +
        `document.querySelector('.about-note')?.value === 'chromium state' && ${noLoading}`,
      'Chromium cancellation did not preserve and restore the current page.'
    )

    return { browserMessages, documentRequests }
  } finally {
    try {
      socket?.close()
    } catch {
      // Browser cleanup is best effort after assertions fail.
    }
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = new Promise<void>((resolveExit) => {
        browser!.once('exit', () => resolveExit())
      })
      browser.kill('SIGTERM')
      let terminationTimer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        exited,
        new Promise<void>((resolveTimeout) => {
          terminationTimer = setTimeout(resolveTimeout, 2_000)
        }),
      ])
      if (terminationTimer) clearTimeout(terminationTimer)
      if (browser.exitCode === null && browser.signalCode === null) {
        const killed = new Promise<void>((resolveExit) => {
          browser!.once('exit', () => resolveExit())
        })
        browser.kill('SIGKILL')
        await killed
      }
    }
  }
}

const installBrowserGlobals = (window: JSDOM['window']) => {
  const names = [
    'window',
    'document',
    'navigator',
    'history',
    'location',
    'Node',
    'Element',
    'HTMLElement',
    'SVGElement',
    'Event',
    'MouseEvent',
    'CustomEvent',
    'MutationObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ] as const
  const descriptors = new Map<string, PropertyDescriptor | undefined>()
  for (const name of names) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    const value =
      name === 'window'
        ? window
        : name === 'document'
          ? window.document
          : name === 'navigator'
            ? window.navigator
            : name === 'history'
              ? window.history
              : name === 'location'
                ? window.location
                : (window as unknown as Record<string, unknown>)[name]
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    })
  }
  return () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete (globalThis as unknown as Record<string, unknown>)[name]
    }
  }
}

afterEach(async () => {
  restoreBrowserGlobals?.()
  restoreBrowserGlobals = undefined
  dom?.window.close()
  dom = undefined
  await managedServer?.close().catch(() => undefined)
  await devServer?.close().catch(() => undefined)
  managedServer = undefined
  devServer = undefined
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
  workspaceRoot = ''
  fixtureRoot = ''
  linkedPackageRoot = ''
  clientOutDir = ''
  vi.restoreAllMocks()
})

const linkDependency = async (
  nodeModulesRoot: string,
  name: string,
  source: string
) => {
  const destination = join(nodeModulesRoot, ...name.split('/'))
  await mkdir(dirname(destination), { recursive: true })
  await symlink(source, destination, 'junction')
}

const prepareLinkedConsumer = async () => {
  workspaceRoot = await realpath(
    await mkdtemp(join(tmpdir(), 'vue-ssr-lite-linked-navigation-'))
  )
  fixtureRoot = join(workspaceRoot, 'consumer')
  linkedPackageRoot = join(workspaceRoot, 'vue-ssr-lite')
  clientOutDir = join(workspaceRoot, 'client-dist')
  await mkdir(linkedPackageRoot, { recursive: true })
  await cp(fixtureSourceRoot, fixtureRoot, { recursive: true })
  await copyFile(
    join(repositoryRoot, 'package.json'),
    join(linkedPackageRoot, 'package.json')
  )

  // Exercise the package exports and emitted entrypoints rather than aliases
  // into src/. The consumer receives its own physical Vue packages so this
  // reproduces the linked-workspace identity boundary from the real example.
  await build({
    root: repositoryRoot,
    configFile: join(repositoryRoot, 'vite.config.ts'),
    logLevel: 'silent',
    build: {
      outDir: join(linkedPackageRoot, 'dist'),
      emptyOutDir: true,
    },
  })

  await symlink(
    join(repositoryRoot, 'node_modules'),
    join(linkedPackageRoot, 'node_modules'),
    'junction'
  )
  const consumerNodeModules = join(fixtureRoot, 'node_modules')
  await mkdir(consumerNodeModules, { recursive: true })
  await cp(
    join(repositoryRoot, 'node_modules/vue'),
    join(consumerNodeModules, 'vue'),
    { recursive: true }
  )
  await cp(
    join(repositoryRoot, 'node_modules/vue-router'),
    join(consumerNodeModules, 'vue-router'),
    { recursive: true }
  )
  await cp(
    join(repositoryRoot, 'node_modules/@vue'),
    join(consumerNodeModules, '@vue'),
    { recursive: true }
  )
  // The physical Vue compiler copies intentionally preserve the linked-package
  // identity boundary. Link their non-Vue transitive dependencies so Node can
  // execute the isolated compiler graph without falling back to the host tree.
  for (const dependency of [
    '@babel',
    '@jridgewell',
    'entities',
    'estree-walker',
    'magic-string',
    'nanoid',
    'picocolors',
    'postcss',
    'source-map-js',
  ]) {
    await linkDependency(
      consumerNodeModules,
      dependency,
      join(repositoryRoot, 'node_modules', dependency)
    )
  }
  await linkDependency(
    consumerNodeModules,
    'vite',
    join(repositoryRoot, 'node_modules/vite')
  )
  await linkDependency(
    consumerNodeModules,
    '@vitejs/plugin-vue',
    join(repositoryRoot, 'node_modules/@vitejs/plugin-vue')
  )
  await linkDependency(
    consumerNodeModules,
    'vue-ssr-lite',
    linkedPackageRoot
  )
}

describe('linked-package real SFC navigation loading consumer', () => {
  it('SSR-renders, hydrates, and keeps navigation loading fully client-side', async () => {
    await prepareLinkedConsumer()
    await build({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      logLevel: 'silent',
      build: {
        outDir: clientOutDir,
        emptyOutDir: true,
      },
    })
    await writeFile(
      join(clientOutDir, 'package.json'),
      '{"type":"module"}\n'
    )

    devServer = await createServer({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      logLevel: 'silent',
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'custom',
    })
    const linkedServerRuntime = (await import(
      `${pathToFileURL(join(linkedPackageRoot, 'dist/server.mjs')).href}?test=${Date.now()}`
    )) as {
      createSsrManagedServer: (options: {
        production: boolean
        root: string
        vite: ViteDevServer
        loadRuntime: () => Promise<unknown>
      }) => Promise<SsrManagedServer>
    }
    managedServer = await linkedServerRuntime.createSsrManagedServer({
      production: false,
      root: fixtureRoot,
      vite: devServer,
      loadRuntime: () => importDevelopmentRuntime(devServer!),
    })
    await managedServer.listen()
    const documentRequests: string[] = []
    managedServer.nodeServer.on('request', (request) => {
      if (String(request.headers.accept ?? '').includes('text/html')) {
        documentRequests.push(request.url ?? '/')
      }
    })

    const warnings: unknown[][] = []
    const errors: unknown[][] = []
    vi.spyOn(console, 'warn').mockImplementation((...values) => {
      warnings.push(values)
    })
    vi.spyOn(console, 'error').mockImplementation((...values) => {
      errors.push(values)
    })

    const origin = `http://127.0.0.1:${managedServer.address().port}`
    const response = await fetch(
      `${origin}/`,
      { headers: { accept: 'text/html' } }
    )
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toMatch(/<a[^>]+href="\/"[^>]*>Home<\/a>/)
    expect(html).toMatch(/<a[^>]+href="\/about"[^>]*>About<\/a>/)
    expect(html).toMatch(/<a[^>]+href="\/dashboard"[^>]*>Dashboard<\/a>/)
    expect(html).toContain('Home page')
    expect(html).not.toContain('page-skeleton')
    expect(html).not.toContain('vssl-loading-indicator')

    const virtualConsole = new VirtualConsole()
    const jsdomErrors: unknown[] = []
    virtualConsole.on('jsdomError', (error) => jsdomErrors.push(error))
    dom = new JSDOM(html, {
      url: response.url,
      pretendToBeVisual: true,
      virtualConsole,
    })
    Object.defineProperty(dom.window, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    })
    dom.window.document.cookie =
      'single_session=yes; Path=/; SameSite=Lax'
    restoreBrowserGlobals = installBrowserGlobals(dom.window)

    const assigned = vi.fn()
    const replaced = vi.fn()
    const browserLocation = dom.window.location
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: {
        get href() {
          return browserLocation.href
        },
        get protocol() {
          return browserLocation.protocol
        },
        get host() {
          return browserLocation.host
        },
        get hostname() {
          return browserLocation.hostname
        },
        get port() {
          return browserLocation.port
        },
        get pathname() {
          return browserLocation.pathname
        },
        get search() {
          return browserLocation.search
        },
        get hash() {
          return browserLocation.hash
        },
        get origin() {
          return browserLocation.origin
        },
        assign: assigned,
        replace: replaced,
      },
    })

    const builtHtml = await readFile(join(clientOutDir, 'index.html'), 'utf8')
    const entryUrl = builtHtml.match(
      /<script[^>]+type="module"[^>]+src="([^"]+\.js)"/
    )?.[1]
    if (!entryUrl) throw new Error('Built consumer client entry is missing.')
    const entryPath = join(clientOutDir, entryUrl.replace(/^\//, ''))
    await import(`${pathToFileURL(entryPath).href}?test=${Date.now()}`)

    await waitFor(
      () =>
        !dom!.window.document.getElementById(getSsrStateElementId('app')),
      'The real SFC application did not finish hydration.'
    )
    expect(dom.window.document.querySelector('.page-skeleton')).toBeNull()
    expect(
      dom.window.document.querySelector('.vssl-loading-indicator')
    ).toBeNull()

    const home = dom.window.document.querySelector('.home-page')
    const header = dom.window.document.querySelector('.persistent-header')
    const sidebar = dom.window.document.querySelector('.persistent-sidebar')
    const aboutLink = dom.window.document.querySelector<HTMLAnchorElement>(
      '.about-link'
    )!
    const dashboardLink = dom.window.document.querySelector<HTMLAnchorElement>(
      '.dashboard-link'
    )!
    const settingsLink = dom.window.document.querySelector<HTMLAnchorElement>(
      '.settings-link'
    )!
    const cancelledLink = dom.window.document.querySelector<HTMLAnchorElement>(
      '.cancelled-link'
    )!
    expect(home).not.toBeNull()
    const initialAboutClick = new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    aboutLink.dispatchEvent(initialAboutClick)
    expect(initialAboutClick.defaultPrevented).toBe(true)
    await waitFor(
      () => Boolean(dom!.window.document.querySelector('.about-page')),
      'The initial About navigation did not render client-side.'
    )
    expect(dom.window.document.querySelector('.home-page')).toBeNull()
    expect(dom.window.document.querySelector('.persistent-header')).toBe(
      header
    )
    expect(dom.window.document.querySelector('.persistent-sidebar')).toBe(
      sidebar
    )
    expect(assigned).not.toHaveBeenCalled()
    expect(replaced).not.toHaveBeenCalled()

    const click = new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    dashboardLink.dispatchEvent(click)

    expect(click.defaultPrevented).toBe(true)
    await waitFor(
      () => Boolean(dom!.window.document.querySelector('.page-skeleton')),
      'The route-area fallback did not appear.'
    )
    expect(dom.window.document.querySelector('.about-page')).toBeNull()
    expect(dom.window.document.querySelector('.persistent-header')).toBe(
      header
    )
    expect(dom.window.document.querySelector('.persistent-sidebar')).toBe(
      sidebar
    )
    expect(
      dom.window.document.querySelector('.vssl-loading-indicator')
    ).not.toBeNull()

    await waitFor(
      () => Boolean(dom!.window.document.querySelector('.dashboard-page')),
      'The Dashboard route did not finish rendering.'
    )
    expect(dom.window.document.querySelector('.page-skeleton')).toBeNull()
    expect(
      dom.window.document.querySelector('.vssl-loading-indicator')
    ).toBeNull()
    expect(dom.window.document.querySelector('.persistent-header')).toBe(
      header
    )
    expect(dom.window.document.querySelector('.persistent-sidebar')).toBe(
      sidebar
    )
    expect(assigned).not.toHaveBeenCalled()
    expect(replaced).not.toHaveBeenCalled()
    expect(jsdomErrors).toEqual([])

    const dashboard = dom.window.document.querySelector('.dashboard-page')
    const nestedLink = dom.window.document.querySelector<HTMLAnchorElement>(
      '.dashboard-nested-link'
    )!
    let nestedLoadingAppeared = false
    const nestedObserver = new dom.window.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (
            node instanceof dom!.window.Element &&
            (node.matches('.page-skeleton, .vssl-loading-indicator') ||
              node.querySelector('.page-skeleton, .vssl-loading-indicator'))
          ) {
            nestedLoadingAppeared = true
          }
        }
      }
    })
    nestedObserver.observe(dom.window.document.body, {
      childList: true,
      subtree: true,
    })
    const documentRequestCount = documentRequests.length
    const nestedClick = new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    nestedLink.dispatchEvent(nestedClick)
    expect(nestedClick.defaultPrevented).toBe(true)
    await waitFor(
      () =>
        Boolean(
          dom!.window.document.querySelector('.dashboard-nested-page')
        ),
      'The nested Dashboard route did not render client-side.'
    )
    await waitFor(
      () =>
        !dom!.window.document.querySelector('.page-skeleton') &&
        !dom!.window.document.querySelector('.vssl-loading-indicator'),
      'The nested Dashboard navigation left loading active.'
    )
    nestedObserver.disconnect()
    expect(nestedLoadingAppeared).toBe(false)
    expect(dom.window.document.querySelector('.dashboard-page')).toBe(dashboard)
    expect(dashboard?.getAttribute('data-auth-runs')).toBe('1')
    expect(dashboard?.textContent).toContain('john')
    expect(dashboard?.textContent).toContain('admin')
    expect(documentRequests).toHaveLength(documentRequestCount)
    expect(assigned).not.toHaveBeenCalled()
    expect(replaced).not.toHaveBeenCalled()

    const aboutClick = new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    dom.window.document
      .querySelector<HTMLAnchorElement>('.about-link')!
      .dispatchEvent(aboutClick)
    expect(aboutClick.defaultPrevented).toBe(true)
    await waitFor(
      () => Boolean(dom!.window.document.querySelector('.about-page')),
      'The About route did not render client-side.'
    )

    let supersededLoadingDisappeared = false
    const supersededClick = new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    dashboardLink.dispatchEvent(supersededClick)
    expect(supersededClick.defaultPrevented).toBe(true)
    await waitFor(
      () => Boolean(dom!.window.document.querySelector('.page-skeleton')),
      'The superseded Dashboard fallback did not appear.'
    )
    const supersededObserver = new dom.window.MutationObserver(() => {
      if (
        !dom!.window.document.querySelector('.settings-page') &&
        !dom!.window.document.querySelector('.page-skeleton')
      ) {
        supersededLoadingDisappeared = true
      }
    })
    supersededObserver.observe(dom.window.document.body, {
      childList: true,
      subtree: true,
    })
    const settingsClick = new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    settingsLink.dispatchEvent(settingsClick)
    expect(settingsClick.defaultPrevented).toBe(true)
    await waitFor(
      () => Boolean(dom!.window.document.querySelector('.settings-page')),
      'The superseding Settings navigation did not render.'
    )
    await waitFor(
      () => !dom!.window.document.querySelector('.page-skeleton'),
      'The superseding Settings navigation did not settle its fallback.'
    )
    supersededObserver.disconnect()
    expect(supersededLoadingDisappeared).toBe(false)
    expect(dom.window.document.querySelector('.dashboard-page')).toBeNull()
    expect(assigned).not.toHaveBeenCalled()
    expect(replaced).not.toHaveBeenCalled()

    const returnToAboutClick = new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    aboutLink.dispatchEvent(returnToAboutClick)
    await waitFor(
      () => Boolean(dom!.window.document.querySelector('.about-page')),
      'About did not render after the superseded navigation.'
    )

    dom.window.document.cookie =
      'single_session=; Path=/; Max-Age=0; SameSite=Lax'
    let loadingStarted = false
    let loadingDisappearedDuringRedirect = false
    const observer = new dom.window.MutationObserver(() => {
      if (
        loadingStarted &&
        !dom!.window.document.querySelector('.login-page') &&
        !dom!.window.document.querySelector('.page-skeleton')
      ) {
        loadingDisappearedDuringRedirect = true
      }
    })
    observer.observe(dom.window.document.body, {
      childList: true,
      subtree: true,
    })

    const unauthenticatedClick = new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    dashboardLink.dispatchEvent(unauthenticatedClick)
    expect(unauthenticatedClick.defaultPrevented).toBe(true)
    await waitFor(
      () => Boolean(dom!.window.document.querySelector('.page-skeleton')),
      'The redirect transaction fallback did not appear.'
    )
    loadingStarted = true
    await waitFor(
      () => Boolean(dom!.window.document.querySelector('.login-page')),
      'The middleware redirect did not render Login.'
    )
    await waitFor(
      () =>
        !dom!.window.document.querySelector('.page-skeleton') &&
        !dom!.window.document.querySelector('.vssl-loading-indicator'),
      'The middleware redirect did not settle its loading UI.'
    )
    observer.disconnect()

    expect(loadingDisappearedDuringRedirect).toBe(false)
    expect(dom.window.location.pathname).toBe('/login')
    expect(dom.window.location.search).toBe('?redirect=/dashboard')
    expect(assigned).not.toHaveBeenCalled()
    expect(replaced).not.toHaveBeenCalled()

    const currentLogin = dom.window.document.querySelector('.login-page')
    const redirectToCurrentDocumentRequests = documentRequests.length
    const redirectToCurrentClick = new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    dashboardLink.dispatchEvent(redirectToCurrentClick)
    expect(redirectToCurrentClick.defaultPrevented).toBe(true)
    await waitFor(
      () => Boolean(dom!.window.document.querySelector('.page-skeleton')),
      'The redirect back to current Login did not show its fallback.'
    )
    await waitFor(
      () =>
        !dom!.window.document.querySelector('.page-skeleton') &&
        !dom!.window.document.querySelector('.vssl-loading-indicator'),
      'The redirect back to current Login did not settle its loading UI.'
    )
    expect(dom.window.location.pathname).toBe('/login')
    expect(dom.window.location.search).toBe('?redirect=/dashboard')
    expect(dom.window.document.querySelector('.login-page')).toBe(currentLogin)
    expect(documentRequests).toHaveLength(redirectToCurrentDocumentRequests)
    expect(assigned).not.toHaveBeenCalled()
    expect(replaced).not.toHaveBeenCalled()

    const cancellationAboutClick = new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    aboutLink.dispatchEvent(cancellationAboutClick)
    await waitFor(
      () => Boolean(dom!.window.document.querySelector('.about-page')),
      'About did not render before cancellation.'
    )
    const preservedAbout = dom.window.document.querySelector('.about-page')
    const preservedInput = dom.window.document.querySelector<HTMLInputElement>(
      '.about-note'
    )!
    preservedInput.value = 'local state'
    preservedInput.dispatchEvent(
      new dom.window.Event('input', { bubbles: true })
    )

    const cancellationClick = new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    cancelledLink.dispatchEvent(cancellationClick)
    expect(cancellationClick.defaultPrevented).toBe(true)
    await waitFor(
      () => Boolean(dom!.window.document.querySelector('.page-skeleton')),
      'The cancellation fallback did not appear.'
    )
    await waitFor(
      () =>
        !dom!.window.document.querySelector('.page-skeleton') &&
        !dom!.window.document.querySelector('.vssl-loading-indicator'),
      'The cancellation loading UI did not settle.'
    )

    expect(dom.window.location.pathname).toBe('/about')
    expect(dom.window.document.querySelector('.about-page')).toBe(
      preservedAbout
    )
    expect(
      dom.window.document.querySelector<HTMLInputElement>('.about-note')?.value
    ).toBe('local state')
    expect(dom.window.document.querySelector('.cancelled-page')).toBeNull()
    expect(assigned).not.toHaveBeenCalled()
    expect(replaced).not.toHaveBeenCalled()

    dom.window.history.back()
    await waitFor(
      () => Boolean(dom!.window.document.querySelector('.login-page')),
      'Browser Back did not remain inside Vue Router.'
    )
    await waitFor(
      () =>
        !dom!.window.document.querySelector('.page-skeleton') &&
        !dom!.window.document.querySelector('.vssl-loading-indicator'),
      'Browser Back left navigation loading active.'
    )
    dom.window.history.forward()
    await waitFor(
      () => Boolean(dom!.window.document.querySelector('.about-page')),
      'Browser Forward did not remain inside Vue Router.'
    )
    await waitFor(
      () =>
        !dom!.window.document.querySelector('.page-skeleton') &&
        !dom!.window.document.querySelector('.vssl-loading-indicator'),
      'Browser Forward left navigation loading active.'
    )

    dom.window.document.cookie =
      'single_session=yes; Path=/; SameSite=Lax'
    for (const [link, page, label] of [
      [dashboardLink, '.dashboard-page', 'repeated Dashboard'],
      [
        dom.window.document.querySelector<HTMLAnchorElement>('.home-link')!,
        '.home-page',
        'repeated Home',
      ],
      [dashboardLink, '.dashboard-page', 'final Dashboard'],
    ] as const) {
      const repeatedClick = new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
      })
      link.dispatchEvent(repeatedClick)
      expect(repeatedClick.defaultPrevented).toBe(true)
      await waitFor(
        () => Boolean(dom!.window.document.querySelector(page)),
        `${label} navigation did not render.`
      )
      await waitFor(
        () =>
          !dom!.window.document.querySelector('.page-skeleton') &&
          !dom!.window.document.querySelector('.vssl-loading-indicator'),
        `${label} navigation left loading active.`
      )
    }

    expect(documentRequests).toEqual(['/'])
    if (browserExecutable) {
      // Undici's Node WebSocket requires Node's Event constructor. The JSDOM
      // navigation phase is complete, so restore host globals before CDP.
      restoreBrowserGlobals?.()
      restoreBrowserGlobals = undefined
      const requestOffset = documentRequests.length
      const browserResult = await runChromiumNavigationRegression(
        browserExecutable,
        origin,
        join(workspaceRoot, 'chromium-profile')
      )
      expect(documentRequests.slice(requestOffset)).toEqual(['/'])
      expect(browserResult.documentRequests).toEqual([`${origin}/`])
      expect(browserResult.browserMessages).toEqual([])
    }
    expect(jsdomErrors).toEqual([])

    const relevantMessages = [...warnings, ...errors]
      .flat()
      .map(String)
      .filter((message) =>
        /hydration|resolveComponent|missing template or render function/i.test(
          message
        )
      )
    expect(relevantMessages).toEqual([])
    expect(warnings).toEqual([])
    expect(errors).toEqual([])
  }, 90_000)
})
