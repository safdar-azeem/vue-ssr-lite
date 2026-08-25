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
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const consumerVersions = {
  pluginVue: process.env.SSR_SMOKE_PLUGIN_VUE_VERSION || '6.0.1',
  jsdom: process.env.SSR_SMOKE_JSDOM_VERSION || '29.0.2',
  vite: process.env.SSR_SMOKE_VITE_VERSION || '7.3.6',
  vue: process.env.SSR_SMOKE_VUE_VERSION || '3.5.40',
  vueRouter: process.env.SSR_SMOKE_VUE_ROUTER_VERSION || '4.6.4',
}
const FRAMEWORK_WARNING =
  /inject\(\) can only be used|Symbol\(route location\)|resolveComponent can only be used|already been installed|reading ['"]meta['"]/i

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

const writeSsrConfig = (consumerRoot, revision) =>
  writeFile(
    join(consumerRoot, 'ssr.config.mjs'),
    `import { defineSsrConfig } from 'vue-ssr-lite/server'

export default defineSsrConfig({
  server: { port: Number(process.env.SMOKE_PORT || 4173) },
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

export default defineConfig({ plugins: [vue(), vueSsrLite()] })
`,
    'utf8'
  )
  await writeSsrConfig(consumerRoot, 'before-hmr')
  await writeFile(
    join(sourceRoot, 'Home.vue'),
    '<template><section id="home-page">packed-home</section></template>\n',
    'utf8'
  )
  await writeFile(
    join(sourceRoot, 'About.vue'),
    '<template><section id="about-page">packed-about</section></template>\n',
    'utf8'
  )
  await writeFile(
    join(sourceRoot, 'NotFound.vue'),
    '<template><section id="not-found-page">packed-not-found</section></template>\n',
    'utf8'
  )
  await writeFile(
    join(sourceRoot, 'Lazy.vue'),
    '<template><section id="lazy-page">packed-lazy</section></template><style>#lazy-page{color:rgb(4,5,6)}</style>\n',
    'utf8'
  )
  await writeFile(join(sourceRoot, 'style.css'), '#routed-app{color:rgb(1,2,3)}\n', 'utf8')
  await writeFile(
    join(sourceRoot, 'App.vue'),
    `<script setup>
import { computed, onMounted } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { usePublicConfig } from 'vue-ssr-lite'

if (!RouterView) throw new Error('host RouterView import is unavailable')
const route = useRoute()
const router = useRouter()
const publicConfig = usePublicConfig()
if (!route) throw new Error('host useRoute() did not resolve the installed router')
if (!router) throw new Error('host useRouter() did not resolve the installed router')

const forceLight = computed(() => route.meta.forceLight !== false)
const navigate = () => router.push('/about')
onMounted(() => document.documentElement.setAttribute('data-hydrated', 'true'))
</script>

<template>
  <main id="routed-app" :data-route="route.path" :data-force-light="String(forceLight)">
    <div id="route-path">{{ route.path }}</div>
    <div id="route-meta">{{ String(route.meta.forceLight) }}</div>
    <div id="public-config-path">{{ publicConfig.pathname }}</div>
    <div id="public-config-application">{{ publicConfig.applicationId }}</div>
    <div id="public-config-revision">{{ publicConfig.revision }}</div>
    <button id="navigate-about" type="button" @click="navigate">about</button>
    <router-view />
  </main>
</template>
`,
    'utf8'
  )
  await writeFile(
    join(sourceRoot, 'main.ts'),
    `import { defineApplication } from 'vue-ssr-lite'
import Home from './Home.vue'
import About from './About.vue'
import NotFound from './NotFound.vue'
import App from './App.vue'
import './style.css'

export default defineApplication({
  root: App,
  routes: [
    { path: '/', component: Home, meta: { forceLight: true, seo: { title: 'Home' } } },
    { path: '/about', component: About, meta: { forceLight: false, seo: { title: 'About' } } },
    { path: '/lazy', component: () => import('./Lazy.vue'), meta: { seo: { title: 'Lazy' } } },
    {
      path: '/:pathMatch(.*)*',
      component: NotFound,
      meta: { forceLight: true, seo: { title: 'Not Found', status: 404 } },
    },
  ],
  seo: { siteUrl: 'https://packed-smoke.test' },
})
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
      if (response.status > 0) return
    } catch {
      // The socket is not listening yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`server readiness timed out\n${processState.output()}`)
}

const startCli = async (consumerRoot, command, port) => {
  const cli = join(consumerRoot, 'node_modules/vue-ssr-lite/dist/cli.mjs')
  const child = spawn(process.execPath, [cli, command, '--root', consumerRoot], {
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
  const state = { child, exited: false, output: () => `${stdout}\n${stderr}` }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  child.once('exit', () => (state.exited = true))
  await waitForServer(`http://127.0.0.1:${port}/`, state)
  return state
}

const stopCli = async (state) => {
  if (state.exited) return
  state.child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolveExit) => state.child.once('exit', resolveExit)),
    new Promise((resolveTimeout) =>
      setTimeout(() => {
        if (!state.exited) state.child.kill('SIGKILL')
        resolveTimeout()
      }, 5_000)
    ),
  ])
}

const assertResponse = async (origin, path, status, markers) => {
  const response = await fetch(`${origin}${path}`)
  const html = await response.text()
  assert(response.status === status, `${path} returned ${response.status}, expected ${status}.`)
  for (const marker of markers) {
    assert(html.includes(marker), `${path} did not contain ${marker}.`)
  }
  return html
}

const assertWarningFree = (output, label) => {
  assert(
    !FRAMEWORK_WARNING.test(output),
    `${label} emitted a framework identity warning:\n${output}`
  )
}

const assertSingleFrameworkResolution = async (consumerRoot) => {
  const hostRequire = createRequire(join(consumerRoot, 'package.json'))
  const packageRoot = join(consumerRoot, 'node_modules/vue-ssr-lite')
  const libraryRequire = createRequire(join(packageRoot, 'dist/index.mjs'))
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
    dom.window.document
      .querySelector('#navigate-about')
      ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
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
      dom.window.document.title === 'About',
      'managed SEO state did not update after client navigation.'
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

  const temporaryRoot = await mkdtemp(join(repositoryRoot, '.package-smoke-'))
  try {
    const packed = await execFile(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', temporaryRoot],
      {
        cwd: repositoryRoot,
      }
    )
    const records = JSON.parse(packed.stdout)
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
            '@vitejs/plugin-vue': consumerVersions.pluginVue,
            jsdom: consumerVersions.jsdom,
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
    await execFile(
      'npm',
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
    assertDependencyOwnership(installedManifest)
    const installedRuntimeTypes = await readFile(
      join(consumerRoot, 'node_modules/vue-ssr-lite/dist/SsrRuntimeTypes.d.ts'),
      'utf8'
    )
    assert(
      /string\s*\|\s*readonly string\[\]\s*\|\s*undefined/.test(
        installedRuntimeTypes
      ),
      'SsrPublicConfigRequest header arrays must be readonly in the public declarations.'
    )
    assert(
      /export type SsrPublicConfigDomain[\s\S]*?params:\s*Readonly<Record<string, string>>[\s\S]*?export interface SsrPublicConfigRequest/.test(
        installedRuntimeTypes
      ),
      'SsrPublicConfigRequest domain params must be readonly in the public declarations.'
    )
    assert(
      await pathExists(join(consumerRoot, 'node_modules/vue-ssr-lite/LICENSE')),
      'the packed package must include the MIT license text.'
    )
    await assertSingleFrameworkResolution(consumerRoot)

    const devPort = await reservePort()
    const dev = await startCli(consumerRoot, 'dev', devPort)
    try {
      const origin = `http://127.0.0.1:${devPort}`
      const home = await assertResponse(origin, '/', 200, [
        'id="routed-app"',
        'data-route="/"',
        'id="route-meta">true',
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
      await writeSsrConfig(consumerRoot, 'after-hmr')
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

    const cli = join(consumerRoot, 'node_modules/vue-ssr-lite/dist/cli.mjs')
    await execFile(process.execPath, [cli, 'build', '--root', consumerRoot], {
      cwd: consumerRoot,
      env: { ...process.env, PUBLIC_URL: 'https://packed-smoke.test' },
    })

    const productionPort = await reservePort()
    const production = await startCli(consumerRoot, 'start', productionPort)
    try {
      const origin = `http://127.0.0.1:${productionPort}`
      const homeHtml = await assertResponse(origin, '/', 200, [
        'id="routed-app"',
        'id="home-page">packed-home',
      ])
      await assertResponse(origin, '/about', 200, ['id="about-page">packed-about'])
      await assertResponse(origin, '/missing', 404, ['id="not-found-page">packed-not-found'])
      const lazyHtml = await assertResponse(origin, '/lazy', 200, [
        'id="lazy-page">packed-lazy',
        'id="public-config-path">/lazy',
      ])
      const homeCss = [...homeHtml.matchAll(/href=["']([^"']+\.css)["']/g)]
      const lazyCss = [...lazyHtml.matchAll(/href=["']([^"']+\.css)["']/g)]
      assert(homeCss.length >= 1, 'production HTML lacks entry CSS.')
      assert(lazyCss.length > homeCss.length, 'production lazy route lacks request-specific CSS.')
      await assertResponse(origin, '/sitemap.xml', 200, [
        '<loc>https://packed-smoke.test/</loc>',
        '<loc>https://packed-smoke.test/about</loc>',
      ])
      await assertResponse(origin, '/robots.txt', 200, [
        'Sitemap: https://packed-smoke.test/sitemap.xml',
      ])
      await assertProductionHydration(consumerRoot, homeHtml, origin)
      assertWarningFree(production.output(), 'production SSR')
    } finally {
      await stopCli(production)
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }

  console.log('[vue-ssr-lite] packed routed host smoke passed')
}

await main()
