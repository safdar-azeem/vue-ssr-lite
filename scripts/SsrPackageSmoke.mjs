import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  assertInstalledArtifactHygiene,
  assertPackedArtifact,
  assertPublicApiChecks,
  writePublicApiChecks,
} from './SsrPackageArtifact.mjs'

const execFile = promisify(execFileCallback)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const consumerVersions = {
  babelTypes: process.env.SSR_SMOKE_BABEL_TYPES_VERSION || '7.29.7',
  pluginVue: process.env.SSR_SMOKE_PLUGIN_VUE_VERSION || '6.0.1',
  jsdom: process.env.SSR_SMOKE_JSDOM_VERSION || '29.0.2',
  nodeTypes: process.env.SSR_SMOKE_NODE_TYPES_VERSION || '24.10.1',
  typescript: process.env.SSR_SMOKE_TYPESCRIPT_VERSION || '5.9.3',
  vite: process.env.SSR_SMOKE_VITE_VERSION || '7.3.6',
  vue: process.env.SSR_SMOKE_VUE_VERSION || '3.5.40',
  vueRouter: process.env.SSR_SMOKE_VUE_ROUTER_VERSION || '4.6.4',
}
const FRAMEWORK_WARNING =
  /\[Vue Router warn\]: No match found for location|inject\(\) can only be used|Symbol\(route location\)|resolveComponent can only be used|Non-function value encountered for default slot|missing template or render function|Hydration completed but contains mismatches|already been installed|reading ['"]meta['"]/i

const assert = (condition, message) => {
  if (!condition) throw new Error(`[vue-ssr-lite] package smoke: ${message}`)
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

const pathExists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

let npmCliPath
const resolveNpmCliPath = async () => {
  if (npmCliPath) return npmCliPath
  const nodeDirectory = dirname(await realpath(process.execPath))
  const environmentCli = [
    process.env.SSR_SMOKE_NPM_CLI,
    process.env.npm_execpath,
  ].find((candidate) => candidate && /(?:^|[\\/])npm-cli\.js$/i.test(candidate))
  const pathDirectories = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')
  const candidates = [
    environmentCli,
    join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'),
    resolve(nodeDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
    ...pathDirectories.flatMap((directory) => [
      join(directory, 'node_modules/npm/bin/npm-cli.js'),
      resolve(directory, '../lib/node_modules/npm/bin/npm-cli.js'),
    ]),
  ].filter(Boolean)

  for (const candidate of new Set(candidates)) {
    if (await pathExists(candidate)) {
      npmCliPath = await realpath(candidate)
      return npmCliPath
    }
  }
  throw new Error(
    'Could not locate npm-cli.js for the packed release smoke. Run through npm or set SSR_SMOKE_NPM_CLI to the npm CLI script.'
  )
}

const runNpm = async (arguments_, options) =>
  execFile(process.execPath, [await resolveNpmCliPath(), ...arguments_], options)

const readMjsTree = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const contents = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) contents.push(await readMjsTree(path))
    else if (entry.name.endsWith('.mjs')) contents.push(await readFile(path, 'utf8'))
  }
  return contents.join('\n')
}

const assertDependencyOwnership = (manifest, options = {}) => {
  const dependencies = manifest.dependencies || {}
  const peerDependencies = manifest.peerDependencies || {}
  const devDependencies = manifest.devDependencies || {}

  for (const [dependency, range] of Object.entries({
    ...dependencies,
    ...peerDependencies,
  })) {
    assert(
      !/^(?:file|link|workspace):/.test(range),
      `${dependency} uses repository-local dependency range ${range}.`
    )
  }

  for (const framework of ['vue', 'vue-router', 'vite']) {
    assert(peerDependencies[framework], `${framework} must remain a host peer dependency.`)
    assert(!dependencies[framework], `${framework} must not be a normal dependency.`)
  }
  assert(
    !dependencies['@vitejs/plugin-vue'],
    '@vitejs/plugin-vue must not be a runtime dependency.'
  )
  assert(
    !dependencies['@vue/server-renderer'],
    '@vue/server-renderer must not be a direct dependency.'
  )
  assert(
    !peerDependencies['@vue/server-renderer'],
    '@vue/server-renderer must not be a peer dependency.'
  )
  for (const dependency of [
    '@apollo/client',
    '@vue/apollo-composable',
    'graphql',
    'vue-apollo-client',
  ]) {
    assert(!dependencies[dependency], `${dependency} must remain consumer-owned.`)
    assert(!peerDependencies[dependency], `${dependency} must remain consumer-owned.`)
  }
  for (const dependency of ['esbuild', 'es-module-lexer']) {
    assert(dependencies[dependency], `${dependency} must remain a runtime dependency.`)
  }
  if (options.requireDevelopmentTooling) {
    for (const framework of ['vue', 'vue-router', 'vite']) {
      assert(
        devDependencies[framework],
        `${framework} must remain available for repository development.`
      )
    }
    assert(
      devDependencies['@vitejs/plugin-vue'],
      '@vitejs/plugin-vue must remain available for repository development.'
    )
  }
}

const writeServerConfig = (consumerRoot, revision) =>
  writeFile(
    join(consumerRoot, 'server.ts'),
    `import { defineServer } from 'vue-ssr-lite'

export default defineServer({
  server: {
    port: Number(process.env.SMOKE_PORT || 4173),
    logger: { error: (event, details) => console.error(event, details) },
  },
  seo: {
    siteUrl: 'https://packed-smoke.test',
    site: {
      resolve: async ({ domain, siteOrigin, signal }) => {
        if (signal.aborted) throw signal.reason
        return {
          status: 'resolved',
          defaults: {
            siteName: 'Packed Tenant',
            titleTemplate: '%s | Packed Tenant',
            description: 'Packed tenant defaults for ' + domain.hostname,
          },
          revision: 'packed-site-seo-v1',
        }
      },
    },
    robots: {
      resolve: async ({ siteOrigin }) => ({
        status: 'resolved',
        config: {
          groups: [{ userAgents: '*', allow: ['/'], disallow: ['/private'] }],
          sitemaps: [siteOrigin + '/sitemap.xml'],
        },
        revision: 'packed-robots-v1',
      }),
    },
  },
  publicConfig: ({ host, pathname, headers, domain }) => ({
    host,
    pathname,
    locale: headers['accept-language'] || 'none',
    applicationId: domain.entry,
    revision: ${JSON.stringify(revision)},
  }),
})
`,
    'utf8'
  )

const writeFixture = async (consumerRoot) => {
  const sourceRoot = join(consumerRoot, 'src')
  await mkdir(sourceRoot, { recursive: true })
  await mkdir(join(consumerRoot, 'public'), { recursive: true })
  await writeFile(
    join(consumerRoot, 'index.html'),
    '<!doctype html><html><head></head><body><div id="app"></div></body></html>\n',
    'utf8'
  )
  await writeFile(
    join(consumerRoot, 'vite.config.mjs'),
    `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vueSsrLite } from 'vue-ssr-lite/vite'

export default defineConfig({
  plugins: [vue(), vueSsrLite()],
  build: { assetsInlineLimit: 0 },
})
`,
    'utf8'
  )
  await writeServerConfig(consumerRoot, 'before-hmr')
  await writeFile(
    join(sourceRoot, 'Home.vue'),
    `<script setup>
import { computed } from 'vue'
import { useSeo } from 'vue-ssr-lite'
useSeo(computed(() => ({ description: 'Packed reactive home' })))
</script>
<template><section id="home-page">packed-home</section></template>
`,
    'utf8'
  )
  await writeFile(
    join(sourceRoot, 'About.vue'),
    '<template><section id="about-page">packed-about</section></template>\n',
    'utf8'
  )
  await writeFile(
    join(sourceRoot, 'Dashboard.vue'),
    `<script setup lang="ts">
defineProps<{ userName: string; authRuns: number }>()
</script>
<template>
  <section id="dashboard-page" :data-auth-runs="authRuns">
    <p id="dashboard-user">{{ userName }}</p>
    <RouterLink id="navigate-dashboard-nested" to="/dashboard/nested">nested</RouterLink>
    <RouterView />
  </section>
</template>
`,
    'utf8'
  )
  await writeFile(
    join(sourceRoot, 'DashboardNested.vue'),
    '<template><section id="dashboard-nested-page">packed-dashboard-nested</section></template>\n',
    'utf8'
  )
  await writeFile(
    join(sourceRoot, 'Login.vue'),
    '<template><section id="login-page">packed-login</section></template>\n',
    'utf8'
  )
  await writeFile(
    join(sourceRoot, 'NotFound.vue'),
    `<script setup>
import { useSeo } from 'vue-ssr-lite'
useSeo({ status: 404 })
</script>
<template><section id="not-found-page">packed-not-found</section></template>
`,
    'utf8'
  )
  await writeFile(
    join(sourceRoot, 'Lazy.vue'),
    '<template><section id="lazy-page">packed-lazy</section></template><style>#lazy-page{color:rgb(4,5,6)}</style>\n',
    'utf8'
  )
  await writeFile(
    join(sourceRoot, 'style.css'),
    "#routed-app{color:rgb(1,2,3);background-image:url('./logo.svg')}\n",
    'utf8'
  )
  await writeFile(
    join(sourceRoot, 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#123456" /></svg>\n',
    'utf8'
  )
  await writeFile(
    join(consumerRoot, 'public', 'application-production1.css'),
    '#public-asset{color:rgb(7,8,9)}\n',
    'utf8'
  )
  await writeFile(
    join(sourceRoot, 'App.vue'),
    `<script setup>
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { LoadingIndicator, RouterView, usePublicConfig } from 'vue-ssr-lite'

const route = useRoute()
const publicConfig = usePublicConfig()
if (!route) throw new Error('host useRoute() did not resolve the installed router')

const forceLight = computed(() => route.meta.forceLight !== false)
onMounted(() => document.documentElement.setAttribute('data-hydrated', 'true'))
</script>

<template>
  <LoadingIndicator :delay="5" />
  <main id="routed-app" :data-route="route.path" :data-force-light="String(forceLight)">
    <div id="route-path">{{ route.path }}</div>
    <div id="route-meta">{{ String(route.meta.forceLight) }}</div>
    <div id="public-config-path">{{ publicConfig.pathname }}</div>
    <div id="public-config-application">{{ publicConfig.applicationId }}</div>
    <div id="public-config-revision">{{ publicConfig.revision }}</div>
    <RouterLink id="navigate-about" to="/about">about</RouterLink>
    <RouterLink id="navigate-dashboard" to="/dashboard">dashboard</RouterLink>
    <RouterView :delay="5">
      <template #fallback>
        <div id="route-fallback">packed-loading</div>
      </template>
    </RouterView>
  </main>
</template>
`,
    'utf8'
  )
  await writeFile(
    join(sourceRoot, 'main.ts'),
    `import { defineMiddleware, type AppContext } from 'vue-ssr-lite'
import Home from './Home.vue'
import About from './About.vue'
import Dashboard from './Dashboard.vue'
import DashboardNested from './DashboardNested.vue'
import Login from './Login.vue'
import NotFound from './NotFound.vue'
import './style.css'

let authRuns = 0
const wait = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolveWait, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveWait()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })

const authMiddleware = defineMiddleware(async (context) => {
  authRuns += 1
  await wait(40, context.signal)
  if (context.cookies.get('packed_session') !== 'yes') {
    return { path: '/login', query: { redirect: context.to.fullPath } }
  }
  return { props: { userName: 'john', authRuns } }
})

const routes = [
  { path: '/', component: Home, meta: { forceLight: true, seo: { title: 'Home' } } },
  { path: '/about', component: About, meta: { forceLight: false, seo: { title: 'About' } } },
  { path: '/lazy', component: () => import('./Lazy.vue'), meta: { seo: { title: 'Lazy' } } },
  {
    path: '/dashboard',
    component: Dashboard,
    meta: { middleware: [authMiddleware], seo: { title: 'Dashboard' } },
    children: [{ path: 'nested', component: DashboardNested }],
  },
  { path: '/login', component: Login, meta: { seo: { title: 'Login' } } },
  {
    path: '/:pathMatch(.*)*',
    component: NotFound,
    meta: { forceLight: true, seo: { title: 'Not Found' } },
  },
]

export { routes }

export default (_context: AppContext) => {
  // Plugins and providers belong here. Core owns createApp / mount.
}
`,
    'utf8'
  )
}

const reservePort = async () =>
  new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => (error ? reject(error) : resolvePort(port)))
    })
  })

const waitForServer = async (origin, processState) => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (processState.exited) {
      throw new Error(`server exited before readiness\n${processState.output()}`)
    }
    try {
      const response = await fetch(origin)
      if (response.status > 0) {
        await response.arrayBuffer()
        return
      }
    } catch {
      // The socket is not listening yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`server readiness timed out\n${processState.output()}`)
}

const startCli = async (consumerRoot, command, port, runtimeRoot = consumerRoot) => {
  const cli = join(consumerRoot, 'node_modules/vue-ssr-lite/dist/cli.mjs')
  const child = spawn(process.execPath, [cli, command, '--root', runtimeRoot], {
    cwd: consumerRoot,
    env: {
      ...process.env,
      SMOKE_PORT: String(port),
      PUBLIC_URL: 'https://packed-smoke.test',
      ...(command === 'start' ? { NODE_ENV: 'production' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let resolveExit
  const exit = new Promise((resolveChildExit) => {
    resolveExit = resolveChildExit
  })
  const state = {
    child,
    exit,
    exited: false,
    code: null,
    signal: null,
    output: () => `${stdout}\n${stderr}`,
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  child.once('exit', (code, signal) => {
    state.exited = true
    state.code = code
    state.signal = signal
    resolveExit()
  })
  await waitForServer(`http://127.0.0.1:${port}/`, state)
  return state
}

const stopCli = async (state) => {
  const shutdownStartedAt = Date.now()
  let forced = false
  if (!state.exited) {
    state.child.kill('SIGTERM')
    let forcedTimer
    try {
      await Promise.race([
        state.exit,
        new Promise((resolveTimeout) => {
          forcedTimer = setTimeout(() => {
            if (!state.exited) {
              forced = true
              state.child.kill('SIGKILL')
            }
            resolveTimeout()
          }, 5_000)
        }),
      ])
    } finally {
      if (forcedTimer) clearTimeout(forcedTimer)
    }
  }
  assert(!forced, `server required SIGKILL during shutdown\n${state.output()}`)
  assert(state.exited, `server did not exit after SIGTERM\n${state.output()}`)
  assert(state.code === 0, `server exited with code ${state.code}\n${state.output()}`)
  assert(
    !state.output().includes('SSR server graceful shutdown timed out.'),
    `server reached its graceful shutdown timeout\n${state.output()}`
  )
  return Date.now() - shutdownStartedAt
}

const assertResponse = async (origin, path, status, markers) => {
  const response = await fetch(`${origin}${path}`)
  const html = await response.text()
  assert(
    response.status === status,
    `${path} returned ${response.status}, expected ${status}. Body: ${html.slice(0, 1000)}`
  )
  for (const marker of markers) {
    assert(html.includes(marker), `${path} did not contain ${marker}.`)
  }
  return html
}

const assertWarningFree = (output, label) => {
  assert(
    !FRAMEWORK_WARNING.test(output),
    `${label} emitted a framework warning:\n${output}`
  )
}

const assertSingleFrameworkResolution = async (consumerRoot) => {
  const hostRequire = createRequire(join(consumerRoot, 'package.json'))
  const packageRoot = join(consumerRoot, 'node_modules/vue-ssr-lite')
  const libraryRequire = createRequire(join(packageRoot, 'dist/index.mjs'))
  for (const [specifier, entry] of [
    ['vue-ssr-lite', 'index.mjs'],
    ['vue-ssr-lite/client', 'client.mjs'],
    ['vue-ssr-lite/server', 'server.mjs'],
    ['vue-ssr-lite/vite', 'vite.mjs'],
  ]) {
    const resolvedEntry = await realpath(hostRequire.resolve(specifier))
    const installedEntry = await realpath(join(packageRoot, 'dist', entry))
    assert(
      resolvedEntry === installedEntry,
      `${specifier} resolved outside the installed npm tarball (${resolvedEntry}).`
    )
  }
  for (const framework of ['vue', 'vue-router']) {
    const hostEntry = await realpath(hostRequire.resolve(framework))
    const libraryEntry = await realpath(libraryRequire.resolve(framework))
    assert(
      hostEntry === libraryEntry,
      `${framework} has different host and library runtime entries (${hostEntry} !== ${libraryEntry}).`
    )
    assert(
      !(await pathExists(join(packageRoot, 'node_modules', framework))),
      `the packed package contains a private ${framework} installation.`
    )
  }
}

const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  throw new Error(message)
}

const assertProductionHydration = async (consumerRoot, html, origin) => {
  const { JSDOM } = await import(
    pathToFileURL(join(consumerRoot, 'node_modules/jsdom/lib/api.js')).href
  )
  const dom = new JSDOM(html, { url: `${origin}/` })
  const previousGlobals = new Map()
  const browserGlobals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    location: dom.window.location,
    history: dom.window.history,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  }
  for (const [key, value] of Object.entries(browserGlobals)) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    })
  }
  const warnings = []
  const originalWarn = console.warn
  const originalError = console.error
  console.warn = (...args) => warnings.push(args.join(' '))
  console.error = (...args) => warnings.push(args.join(' '))
  try {
    const moduleSource = html.match(
      /<script\b[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/i
    )?.[1]
    assert(moduleSource, 'production HTML did not contain the generated browser entry.')
    const modulePath = join(consumerRoot, 'dist/client', moduleSource.replace(/^\//, ''))
    await import(`${pathToFileURL(modulePath).href}?smoke=${Date.now()}`)
    await waitFor(
      () => dom.window.document.documentElement.getAttribute('data-hydrated') === 'true',
      'the generated browser entry did not hydrate the SSR application.'
    )
    assert(
      dom.window.document.querySelector('#routed-app')?.getAttribute('data-route') === '/',
      'hydration did not retain the initial route.'
    )
    const clickRouterLink = (selector) => {
      const navigationClick = new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
      })
      const link = dom.window.document.querySelector(selector)
      assert(link, `RouterLink ${selector} was not rendered.`)
      link.dispatchEvent(navigationClick)
      assert(
        navigationClick.defaultPrevented,
        `RouterLink ${selector} did not prevent native document navigation.`
      )
    }
    clickRouterLink('#navigate-about')
    await waitFor(
      () => dom.window.document.querySelector('#about-page'),
      'router.push(/about) did not update RouterView after hydration.'
    )
    assert(
      dom.window.document.querySelector('#routed-app')?.getAttribute('data-route') === '/about',
      'useRoute() did not update after client navigation.'
    )
    assert(
      dom.window.document.querySelector('#route-meta')?.textContent === 'false',
      'route.meta did not update after client navigation.'
    )
    assert(
      dom.window.document.title === 'About | Packed Tenant',
      'managed SEO state did not update after client navigation.'
    )

    dom.window.document.cookie = 'packed_session=yes; Path=/; SameSite=Lax'
    clickRouterLink('#navigate-dashboard')
    await waitFor(
      () =>
        Boolean(dom.window.document.querySelector('#route-fallback')) &&
        Boolean(dom.window.document.querySelector('.vssl-loading-indicator')),
      'packed RouterView and LoadingIndicator did not show slow middleware.'
    )
    await waitFor(
      () =>
        dom.window.document.querySelector('#dashboard-page')?.getAttribute('data-auth-runs') ===
          '1' &&
        !dom.window.document.querySelector('#route-fallback') &&
        !dom.window.document.querySelector('.vssl-loading-indicator'),
      'packed route middleware did not settle the authenticated Dashboard navigation.'
    )
    assert(
      dom.window.document.querySelector('#dashboard-user')?.textContent === 'john',
      'packed middleware props did not reach the declaring route component.'
    )
    clickRouterLink('#navigate-dashboard-nested')
    await waitFor(
      () => Boolean(dom.window.document.querySelector('#dashboard-nested-page')),
      'packed nested Dashboard navigation did not render.'
    )
    assert(
      dom.window.document.querySelector('#dashboard-page')?.getAttribute('data-auth-runs') === '1',
      'packed nested navigation reran middleware on its unchanged parent route.'
    )

    clickRouterLink('#navigate-about')
    await waitFor(
      () => Boolean(dom.window.document.querySelector('#about-page')),
      'packed navigation did not return to About before redirect coverage.'
    )
    dom.window.document.cookie =
      'packed_session=; Path=/; Max-Age=0; SameSite=Lax'
    clickRouterLink('#navigate-dashboard')
    await waitFor(
      () =>
        Boolean(dom.window.document.querySelector('#login-page')) &&
        !dom.window.document.querySelector('#route-fallback') &&
        !dom.window.document.querySelector('.vssl-loading-indicator'),
      'packed middleware redirect did not settle on Login.'
    )
    assert(
      dom.window.document.querySelector('#route-path')?.textContent === '/login',
      'packed middleware redirect did not remain Vue Router navigation.'
    )
    assertWarningFree(warnings.join('\n'), 'production hydration/navigation')
  } finally {
    console.warn = originalWarn
    console.error = originalError
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
    dom.window.close()
  }
}

const main = async () => {
  const repositoryManifest = await readJson(join(repositoryRoot, 'package.json'))
  assertDependencyOwnership(repositoryManifest, {
    requireDevelopmentTooling: true,
  })

  const builtServer = await readMjsTree(join(repositoryRoot, 'dist'))
  assert(
    /vue\/server-renderer/.test(builtServer),
    'the built server entry must keep vue/server-renderer external.'
  )
  assert(
    !/@vue\/server-renderer/.test(builtServer),
    'the built server entry must not reference the obsolete renderer package.'
  )

  const temporaryRoot = await realpath(
    await mkdtemp(join(tmpdir(), 'vue-ssr-lite-package-smoke-'))
  )
  try {
    const packed = await runNpm(
      ['pack', '--ignore-scripts', '--json', '--pack-destination', temporaryRoot],
      {
        cwd: repositoryRoot,
      }
    )
    const records = JSON.parse(packed.stdout)
    const packedFiles = assertPackedArtifact({
      record: records[0],
      manifest: repositoryManifest,
      assert,
    })
    const tarball = join(temporaryRoot, records[0].filename)
    const consumerRoot = join(temporaryRoot, 'consumer')
    await mkdir(consumerRoot, { recursive: true })
    await writeFile(
      join(consumerRoot, 'package.json'),
      JSON.stringify(
        {
          private: true,
          type: 'module',
          dependencies: {
            '@babel/types': consumerVersions.babelTypes,
            '@types/node': consumerVersions.nodeTypes,
            '@vitejs/plugin-vue': consumerVersions.pluginVue,
            jsdom: consumerVersions.jsdom,
            typescript: consumerVersions.typescript,
            vue: consumerVersions.vue,
            'vue-router': consumerVersions.vueRouter,
            vite: consumerVersions.vite,
            'vue-ssr-lite': `file:${tarball}`,
          },
        },
        null,
        2
      ),
      'utf8'
    )
    await writeFixture(consumerRoot)
    await writePublicApiChecks(consumerRoot)
    await runNpm(
      [
        'install',
        '--install-strategy=nested',
        '--ignore-scripts',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
      ],
      { cwd: consumerRoot }
    )

    const installedManifest = await readJson(
      join(consumerRoot, 'node_modules/vue-ssr-lite/package.json')
    )
    assert(
      installedManifest.version === repositoryManifest.version,
      'the installed tarball version does not match the repository manifest.'
    )
    assertDependencyOwnership(installedManifest)
    await assertInstalledArtifactHygiene({
      consumerRoot,
      packedFiles,
      repositoryRoot,
      assert,
    })
    const [
      installedRootTypes,
      installedClientTypes,
      installedServerTypes,
      installedViteTypes,
    ] = await Promise.all(
      ['index.d.ts', 'client.d.ts', 'server.d.ts', 'vite.d.ts'].map((filename) =>
        readFile(
          join(consumerRoot, 'node_modules/vue-ssr-lite/dist', filename),
          'utf8'
        )
      )
    )
    const installedPublicTypes = [
      installedRootTypes,
      installedClientTypes,
      installedServerTypes,
      installedViteTypes,
    ].join('\n')
    assert(
      /string\s*\|\s*readonly string\[\]\s*\|\s*undefined/.test(
        installedPublicTypes
      ),
      'SsrPublicConfigRequest header arrays must be readonly in the public declarations.'
    )
    assert(
      /\b(?:type|interface) SsrPublicConfigDomain\b[\s\S]*?params:\s*Readonly<Record<string, string>>/.test(
        installedPublicTypes
      ) && /\binterface SsrPublicConfigRequest\b/.test(installedPublicTypes),
      'SsrPublicConfigRequest domain params must be readonly in the public declarations.'
    )
    assert(
      !/\bRobotsLegacyConfig\b/.test(`${installedRootTypes}\n${installedServerTypes}`),
      'RobotsLegacyConfig must not exist in public entrypoint declarations.'
    )
    assert(
      !/\bSeoInput\b/.test(`${installedRootTypes}\n${installedServerTypes}`),
      'SeoInput must not exist in public entrypoint declarations; use SeoPageInput.'
    )
    assert(
      !/\bSsrConfig\b/.test(installedServerTypes),
      'the internal SsrConfig alias must not exist in the server entrypoint declaration.'
    )
    assert(
      !/\bSsrViteApplicationEntry\b/.test(installedViteTypes),
      'the internal Vite application entry must not exist in the Vite entrypoint declaration.'
    )
    assert(
      await pathExists(join(consumerRoot, 'node_modules/vue-ssr-lite/LICENSE')),
      'the packed package must include the MIT license text.'
    )
    const cliTarget = join(
      consumerRoot,
      'node_modules/vue-ssr-lite',
      installedManifest.bin['vue-ssr-lite'].replace(/^\.\//, '')
    )
    const cliSource = await readFile(cliTarget, 'utf8')
    assert(cliSource.startsWith('#!/usr/bin/env node\n'), 'the packed CLI lacks its Node shebang.')
    if (process.platform !== 'win32') {
      assert(
        ((await stat(cliTarget)).mode & 0o111) !== 0,
        'npm did not install the packed CLI target as executable.'
      )
    }
    const packageBin = join(
      consumerRoot,
      'node_modules/.bin',
      process.platform === 'win32' ? 'vue-ssr-lite.cmd' : 'vue-ssr-lite'
    )
    assert(await pathExists(packageBin), 'npm did not create the vue-ssr-lite binary shim.')

    await assertPublicApiChecks(consumerRoot)
    const { root: packedRoot } = await import(
      `${pathToFileURL(join(consumerRoot, 'package-import-smoke.mjs')).href}?inspect=${Date.now()}`
    )
    assert(typeof packedRoot.defineServer === 'function', 'defineServer must export from vue-ssr-lite.')
    assert(typeof packedRoot.defineServerRoutes === 'function', 'defineServerRoutes must export from vue-ssr-lite.')
    assert(typeof packedRoot.defineServerMiddleware === 'function', 'defineServerMiddleware must export from vue-ssr-lite.')
    assert(
      typeof packedRoot.defineApplication === 'function',
      'defineApplication must export from vue-ssr-lite.'
    )
    assert(typeof packedRoot.useSeo === 'function', 'useSeo must export from vue-ssr-lite.')
    assert(
      typeof packedRoot.useDomain === 'function',
      'useDomain must export from vue-ssr-lite.'
    )
    assert(
      typeof packedRoot.useOrigin === 'function',
      'useOrigin must export from vue-ssr-lite.'
    )
    assert(
      typeof packedRoot.setHttpStatus === 'function',
      'setHttpStatus must export from vue-ssr-lite.'
    )
    assert(
      typeof packedRoot.redirectTo === 'function',
      'redirectTo must export from vue-ssr-lite.'
    )
    for (const obsoleteName of [
      'useSsrDomain',
      'useSiteOrigin',
      'setResponseStatus',
      'setResponseRedirect',
    ]) {
      assert(
        packedRoot[obsoleteName] === undefined,
        `${obsoleteName} must not exist on the packaged root export.`
      )
      assert(
        !new RegExp(`\\b${obsoleteName}\\b`).test(
          `${installedRootTypes}\n${installedClientTypes}\n${installedServerTypes}`
        ),
        `${obsoleteName} must not exist in packaged public declarations.`
      )
    }
    assert(
      packedRoot.defineSsrConfig === undefined,
      'defineSsrConfig must not exist on the packaged root export.'
    )
    await assertSingleFrameworkResolution(consumerRoot)

    const devPort = await reservePort()
    const dev = await startCli(consumerRoot, 'dev', devPort)
    try {
      const origin = `http://127.0.0.1:${devPort}`
      const coldConcurrent = await Promise.all(
        ['/', '/', '/lazy'].map((path) => fetch(`${origin}${path}`))
      )
      const coldConcurrentBodies = await Promise.all(
        coldConcurrent.map(async (response, index) => {
          assert(
            response.status === 200,
            `cold concurrent request ${index + 1} returned ${response.status}.`
          )
          return response.text()
        })
      )
      assert(
        coldConcurrentBodies[0].includes('id="home-page">packed-home'),
        'cold concurrent root request did not render the home route.'
      )
      assert(
        coldConcurrentBodies[2].includes('id="lazy-page">packed-lazy'),
        'cold concurrent lazy request did not render the lazy route.'
      )
      const home = await assertResponse(origin, '/', 200, [
        'id="routed-app"',
        'data-route="/"',
        'id="route-meta">true',
        'href="/about"',
        'id="home-page">packed-home',
        'id="public-config-path">/',
        'id="public-config-application">app',
        'id="public-config-revision">before-hmr',
      ])
      await assertResponse(origin, '/about', 200, [
        'data-route="/about"',
        'id="route-meta">false',
        'id="about-page">packed-about',
      ])
      await assertResponse(origin, '/definitely-missing', 404, [
        'id="not-found-page">packed-not-found',
      ])
      const lazy = await assertResponse(origin, '/lazy', 200, [
        'id="lazy-page">packed-lazy',
        'id="public-config-path">/lazy',
      ])
      assert(home.includes('/src/style.css'), 'development HTML lacks entry CSS.')
      assert(
        lazy.includes('data-vue-ssr-lite-rendered-style'),
        'development lazy route lacks request-rendered CSS.'
      )
      await writeServerConfig(consumerRoot, 'after-hmr')
      let updatedHtml = ''
      await waitFor(async () => {
        const response = await fetch(`${origin}/`)
        updatedHtml = await response.text()
        return updatedHtml.includes('id="public-config-revision">after-hmr')
      }, 'development SSR did not observe the updated publicConfig factory.')
      assertWarningFree(dev.output(), 'development Vite SSR')
    } finally {
      await stopCli(dev)
    }

    const cli = cliTarget
    const buildCommand =
      process.platform === 'win32'
        ? { executable: process.execPath, arguments: [cli, 'build', '--root', consumerRoot] }
        : { executable: packageBin, arguments: ['build', '--root', consumerRoot] }
    await execFile(buildCommand.executable, buildCommand.arguments, {
      cwd: consumerRoot,
      env: { ...process.env, PUBLIC_URL: 'https://packed-smoke.test' },
    })
    const builtClient = await readMjsTree(join(consumerRoot, 'dist', 'client'))
    assert(
      !builtClient.includes('packed-site-seo-v1') &&
        !builtClient.includes('packed-robots-v1') &&
        !builtClient.includes('Packed tenant defaults for'),
      'server-only siteSeo/siteRobots resolver data leaked into the client bundle.'
    )

    const productionPort = await reservePort()
    const production = await startCli(consumerRoot, 'start', productionPort)
    try {
      const origin = `http://127.0.0.1:${productionPort}`
      const homeHtml = await assertResponse(origin, '/', 200, [
        'id="routed-app"',
        'href="/about"',
        'id="home-page">packed-home',
      ])
      await assertResponse(origin, '/about', 200, ['id="about-page">packed-about'])
      await assertResponse(origin, '/missing', 404, ['id="not-found-page">packed-not-found'])
      const lazyHtml = await assertResponse(origin, '/lazy', 200, [
        'id="lazy-page">packed-lazy',
        'id="public-config-path">/lazy',
      ])
      const productionManifest = await readJson(
        join(consumerRoot, 'dist', 'client', '.vite', 'manifest.json')
      )
      const importedAsset = Object.values(productionManifest)
        .flatMap((entry) => entry.assets || [])
        .find((asset) => asset.endsWith('.svg'))
      assert(importedAsset, 'production manifest did not contain the imported SVG asset.')
      const homeCss = [...homeHtml.matchAll(/href=["']([^"']+\.css)["']/g)]
      const lazyCss = [...lazyHtml.matchAll(/href=["']([^"']+\.css)["']/g)]
      assert(homeCss.length >= 1, 'production HTML lacks entry CSS.')
      assert(lazyCss.length > homeCss.length, 'production lazy route lacks request-specific CSS.')
      try {
        await assertResponse(origin, '/sitemap.xml', 200, [
          '<loc>https://packed-smoke.test/</loc>',
          '<loc>https://packed-smoke.test/about</loc>',
        ])
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : error}\n${production.output()}`)
      }
      await assertResponse(origin, '/robots.txt', 200, [
        'Sitemap: https://packed-smoke.test/sitemap.xml',
      ])
      for (const privatePath of [
        '/.vite/manifest.json',
        '/.vite/ssr-manifest.json',
        '/.vite/vue-ssr-lite-assets.json',
        '/.%76ite/manifest.json',
      ]) {
        await assertResponse(origin, privatePath, 404, [])
      }
      const publicCssPath = homeCss[0][1]
      const publicCss = await fetch(`${origin}${publicCssPath}`)
      assert(publicCss.status === 200, 'production public CSS did not remain available.')
      assert(
        publicCss.headers.get('cache-control') === 'public, max-age=31536000, immutable',
        'production revisioned entry CSS did not receive immutable caching.'
      )
      const publicCssEtag = publicCss.headers.get('etag')
      assert(publicCssEtag, 'production public CSS did not include an ETag.')
      await publicCss.arrayBuffer()
      const publicCssHead = await fetch(`${origin}${publicCssPath}`, { method: 'HEAD' })
      assert(publicCssHead.status === 200, 'production public CSS HEAD request failed.')
      const publicCssNotModified = await fetch(`${origin}${publicCssPath}`, {
        headers: { 'if-none-match': publicCssEtag },
      })
      assert(publicCssNotModified.status === 304, 'production public CSS ETag request failed.')
      for (const [, lazyCssPath] of lazyCss) {
        const lazyCssResponse = await fetch(`${origin}${lazyCssPath}`)
        assert(
          lazyCssResponse.status === 200,
          'production revisioned lazy CSS did not remain available.'
        )
        assert(
          lazyCssResponse.headers.get('cache-control') ===
            'public, max-age=31536000, immutable',
          'production revisioned lazy CSS did not receive immutable caching.'
        )
        await lazyCssResponse.arrayBuffer()
      }
      const importedAssetResponse = await fetch(`${origin}/${importedAsset}`)
      assert(importedAssetResponse.status === 200, 'production imported SVG did not remain available.')
      assert(
        importedAssetResponse.headers.get('cache-control') ===
          'public, max-age=31536000, immutable',
        'production revisioned imported SVG did not receive immutable caching.'
      )
      await importedAssetResponse.arrayBuffer()
      const mutablePublicCss = await fetch(`${origin}/application-production1.css`)
      assert(mutablePublicCss.status === 200, 'production public CSS fixture did not remain available.')
      assert(
        mutablePublicCss.headers.get('cache-control') === 'public, max-age=3600',
        'mutable public CSS unexpectedly received immutable caching.'
      )
      await mutablePublicCss.arrayBuffer()
      await assertProductionHydration(consumerRoot, homeHtml, origin)
      assertWarningFree(production.output(), 'production SSR')
    } finally {
      await stopCli(production)
    }

    await writeFile(
      join(consumerRoot, 'vite.config.mjs'),
      `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vueSsrLite } from 'vue-ssr-lite/vite'

export default defineConfig({
  plugins: [vue(), vueSsrLite()],
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
`,
      'utf8'
    )
    await execFile(process.execPath, [cli, 'build', '--root', consumerRoot], {
      cwd: consumerRoot,
      env: { ...process.env, PUBLIC_URL: 'https://packed-smoke.test' },
    })
    const stableManifest = await readJson(
      join(consumerRoot, 'dist', 'client', '.vite', 'manifest.json')
    )
    const stableEntry = Object.values(stableManifest).find(
      (entry) => entry.isEntry && entry.file?.endsWith('.js')
    )?.file
    const stableCss = Object.values(stableManifest)
      .flatMap((entry) => entry.css || [])
      .find((asset) => asset.endsWith('.css'))
    const stableImportedAsset = Object.values(stableManifest)
      .flatMap((entry) => entry.assets || [])
      .find((asset) => asset.endsWith('.svg'))
    assert(stableEntry, 'stable-output manifest did not contain the entry JavaScript.')
    assert(stableCss, 'stable-output manifest did not contain extracted CSS.')
    assert(stableImportedAsset, 'stable-output manifest did not contain the imported SVG asset.')

    const stablePort = await reservePort()
    const stableProduction = await startCli(consumerRoot, 'start', stablePort)
    try {
      const stableOrigin = `http://127.0.0.1:${stablePort}`
      for (const asset of [stableEntry, stableCss, stableImportedAsset]) {
        const response = await fetch(`${stableOrigin}/${asset}`)
        assert(response.status === 200, `stable Vite asset ${asset} did not remain available.`)
        assert(
          response.headers.get('cache-control') === 'public, max-age=3600',
          `stable Vite asset ${asset} unexpectedly received immutable caching.`
        )
        await response.arrayBuffer()
      }
      assertWarningFree(stableProduction.output(), 'stable-output production SSR')
    } finally {
      await stopCli(stableProduction)
    }

    await writeFile(
      join(consumerRoot, 'vite.config.mjs'),
      `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vueSsrLite } from 'vue-ssr-lite/vite'

const explicitAssets = [
  {
    fileName: 'assets/manual-stable.css',
    name: 'manual-stable.css',
    originalFileName: 'src/manual-stable.css',
    source: 'body { color: red }',
  },
  {
    fileName: 'assets/manual-ABCDEF12.svg',
    name: 'manual.svg',
    originalFileName: 'src/manual.svg',
    source: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
  },
]

const explicitAssetPlugin = () => {
  let references = []
  return {
    name: 'packed-explicit-output-assets',
    enforce: 'pre',
    buildStart() {
      references = explicitAssets.map((asset) => this.emitFile({ type: 'asset', ...asset }))
    },
    transform(code, id) {
      if (!id.endsWith('/src/main.ts')) return
      return code + '\\nglobalThis.__explicitAssetUrls = ['
        + references.map((reference) => 'import.meta.ROLLUP_FILE_URL_' + reference).join(', ')
        + ']'
    },
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find((output) => output.type === 'chunk' && output.isEntry)
      if (!entry?.viteMetadata) throw new Error('Missing Vite entry asset metadata.')
      for (const { fileName } of explicitAssets) entry.viteMetadata.importedAssets.add(fileName)
    },
  }
}

export default defineConfig({
  plugins: [explicitAssetPlugin(), vue(), vueSsrLite()],
  build: { assetsInlineLimit: 0 },
})
`,
      'utf8'
    )
    await execFile(process.execPath, [cli, 'build', '--root', consumerRoot], {
      cwd: consumerRoot,
      env: { ...process.env, PUBLIC_URL: 'https://packed-smoke.test' },
    })
    const explicitAssetNames = [
      'assets/manual-stable.css',
      'assets/manual-ABCDEF12.svg',
    ]
    const explicitManifest = await readJson(
      join(consumerRoot, 'dist', 'client', '.vite', 'manifest.json')
    )
    const explicitManifestAssets = new Set(
      Object.values(explicitManifest).flatMap((entry) => entry.assets || [])
    )
    for (const asset of explicitAssetNames) {
      assert(explicitManifestAssets.has(asset), `explicit Vite asset ${asset} was not manifest-owned.`)
    }

    const explicitPort = await reservePort()
    const explicitProduction = await startCli(consumerRoot, 'start', explicitPort)
    try {
      const explicitOrigin = `http://127.0.0.1:${explicitPort}`
      for (const asset of explicitAssetNames) {
        const response = await fetch(`${explicitOrigin}/${asset}`)
        assert(response.status === 200, `explicit Vite asset ${asset} did not remain available.`)
        assert(
          response.headers.get('cache-control') === 'public, max-age=3600',
          `explicit Vite asset ${asset} unexpectedly received immutable caching.`
        )
        await response.arrayBuffer()
      }
      assertWarningFree(explicitProduction.output(), 'explicit-output production SSR')
    } finally {
      await stopCli(explicitProduction)
    }

    await writeFile(
      join(consumerRoot, 'server.ts'),
      `import { defineServer } from 'vue-ssr-lite'
export default defineServer({
  server: { port: Number(process.env.SMOKE_PORT) },
  render: 'spa',
})
`,
      'utf8'
    )
    await writeFile(
      join(consumerRoot, 'vite.config.mjs'),
      `import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vueSsrLite } from 'vue-ssr-lite/vite'

export default defineConfig({ base: '/app/', plugins: [vue(), vueSsrLite()] })
`,
      'utf8'
    )
    const customBaseAlias = join(temporaryRoot, 'consumer-custom-base-alias')
    await symlink(consumerRoot, customBaseAlias, 'dir')
    for (let run = 1; run <= 10; run += 1) {
      const port = await reservePort()
      const spaDev = await startCli(consumerRoot, 'dev', port, customBaseAlias)
      try {
        await assertResponse(`http://127.0.0.1:${port}`, '/app/', 200, [
          'vue-ssr-lite-domain',
        ])
        for (const path of [
          '/app/@vite/client',
          '/app/@vue-ssr-lite/client/app',
          '/app/src/main.ts',
        ]) {
          await assertResponse(`http://127.0.0.1:${port}`, path, 200, [])
        }
        assertWarningFree(spaDev.output(), 'packed custom-base development resources')
      } finally {
        const shutdownMs = await stopCli(spaDev)
        console.log(`[vue-ssr-lite] custom-base SPA shutdown run ${run}: ${shutdownMs}ms`)
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }

  console.log('[vue-ssr-lite] packed routed host smoke passed')
}

await main()
