import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, isRunnableDevEnvironment, normalizePath, type ViteDevServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { SSR_RUNTIME_VIRTUAL_ID } from '../SsrConfigCompileRuntime'
import { closeViteDevServer, provisionHostVuePeers } from '../SsrTestFixtures'
import { createSsrManagedServer, type SsrManagedServer } from '../server/SsrServerRuntime'
import { importSsrViteModule } from './SsrViteModuleRuntime'
import { vueSsrLite } from './SsrVitePlugin'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  return { promise, resolve }
}

let root = ''
let vite: ViteDevServer | undefined
let managed: SsrManagedServer | undefined
let hmr: Server | undefined
let releaseSsr: (() => void) | undefined

afterEach(async () => {
  releaseSsr?.()
  await managed?.close()
  await closeViteDevServer(vite, hmr)
  managed = undefined
  vite = undefined
  hmr = undefined
  releaseSsr = undefined
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  root = ''
})

describe('request-selected lazy route asset preparation', () => {
  it.each(['/', '/products/'])('prepares only the selected graph alongside native navigation under base %s', async (base) => {
    // Vite canonicalizes filesystem module ids. In particular, macOS temp
    // paths under /var resolve under /private/var; otherwise the transform
    // gates below never recognize the component and remain pending forever.
    root = await realpath(await mkdtemp(join(tmpdir(), 'vue-ssr-lite-lazy-assets-')))
    await mkdir(join(root, 'src'))
    await provisionHostVuePeers(root)
    await mkdir(join(root, 'node_modules/cold-widget'))
    const sources = {
      'index.html': '<html><head></head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>',
      'server.ts': `export default {
        publicConfig: ({ headers }) => ({ marker: headers['x-marker'] }),
        server: { port: 0, diagnostics: false }
      }`,
      'src/main.ts': `export { routes } from './routes'
        export default () => {}`,
      'src/routes.ts': `export const events = []
        export const routes = [
          { path: '/', beforeEnter: to => { events.push('guard:' + to.path) },
            component: () => { events.push('load:home'); return import('./Home.vue') } },
          { path: '/unused', component: () => { events.push('load:unused'); return import('./Unused.vue') } },
          { path: '/redirect', redirect: '/' }
        ]`,
      'src/App.vue': '<script setup>import { RouterView } from "vue-router"</script><template><RouterView /></template>',
      'src/Home.vue': `<script setup>
        import Panel from './Panel.vue'
        import './home.css'
        import { usePublicConfig } from 'vue-ssr-lite'
        const config = usePublicConfig()
        </script><template><main>Home-A {{ config.marker }}<Panel /></main></template>`,
      'src/Panel.vue': `<script setup>
        import widget from 'cold-widget'
        import './panel.css'
        </script><template><section class="panel">Panel-A {{ widget.label }}</section></template>
        <style scoped>.panel { display: grid }</style>`,
      'src/home.css': 'main { color: navy }',
      'src/panel.css': '.panel { color: purple }',
      'src/Unused.vue': '<script setup>import "./unused.css"</script><template><p>unused route</p></template>',
      'src/unused.css': '.unused { color: red }',
      'node_modules/cold-widget/package.json': JSON.stringify({ name: 'cold-widget', version: '1.0.0', main: 'index.cjs' }),
      'node_modules/cold-widget/index.cjs': 'module.exports = { label: "widget-ready" }',
    }
    await Promise.all(Object.entries(sources).map(([file, source]) => writeFile(join(root, file), source)))

    const ssrStarted = deferred()
    const allowSsr = deferred()
    const clientPanelStarted = deferred()
    releaseSsr = allowSsr.resolve
    const transformed = new Map<string, number>()
    const homeId = normalizePath(join(root, 'src/Home.vue'))
    const panelId = normalizePath(join(root, 'src/Panel.vue'))
    const unusedId = normalizePath(join(root, 'src/Unused.vue'))
    hmr = createHttpServer()
    vite = await createServer({
      root, base, configFile: false, logLevel: 'silent',
      resolve: { alias: {
        'vue-ssr-lite/client': fileURLToPath(new URL('../client.ts', import.meta.url)),
        'vue-ssr-lite/server': fileURLToPath(new URL('../server.ts', import.meta.url)),
        'vue-ssr-lite': fileURLToPath(new URL('../index.ts', import.meta.url)),
      } },
      plugins: [
        vueSsrLite({ root }),
        {
          name: 'observe-selected-component-transforms', enforce: 'pre',
          async transform(_code, id, options) {
            const key = `${options?.ssr ? 'ssr' : 'client'}:${id}`
            transformed.set(key, (transformed.get(key) ?? 0) + 1)
            if (options?.ssr && id === homeId) {
              ssrStarted.resolve()
              await allowSsr.promise
            }
            if (!options?.ssr && id === panelId) clientPanelStarted.resolve()
            return null
          },
        },
        vue(),
      ],
      server: { middlewareMode: true, hmr: { server: hmr } }, appType: 'custom',
    })
    managed = await createSsrManagedServer({ production: false, root, vite,
      loadRuntime: () => importSsrViteModule(vite!, SSR_RUNTIME_VIRTUAL_ID) })
    await managed.listen()
    const ssr = vite.environments.ssr
    if (!isRunnableDevEnvironment(ssr)) throw new Error('Expected Vite to own a runnable SSR environment.')
    const { events } = await importSsrViteModule<{ events: string[] }>(vite, '/src/routes.ts')
    const page = (path: string, marker: string) => new Promise<{ status: number; body: string }>((yes, no) => {
      const req = request({ hostname: '127.0.0.1', port: managed!.address().port, path, agent: false,
        headers: { host: 'localhost', accept: 'text/html', 'x-marker': marker } }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk })
        res.on('error', no)
        res.on('end', () => yes({ status: res.statusCode!, body }))
      })
      req.on('error', no)
      req.end()
    })
    const styles = (body: string) => [...body.matchAll(/<link\b[^>]*\bhref="([^"]+)"[^>]*>/g)]
      .map((match) => match[1].replaceAll('&amp;', '&'))

    // Runtime/client-shell startup may discover lazy import edges, but it must
    // neither invoke the loaders nor transform their SSR/client components.
    expect(events).toEqual([])
    for (const id of [homeId, panelId, unusedId]) {
      expect(transformed.has(`ssr:${id}`)).toBe(false)
      expect(transformed.has(`client:${id}`)).toBe(false)
      expect(ssr.runner.evaluatedModules.getModuleById(id)?.evaluated).not.toBe(true)
    }
    const first = page('/', 'one')
    // Rejection remains observed if an architectural assertion fails while the
    // HTTP request is deliberately blocked in the test's SSR transform hook.
    void first.catch(() => undefined)
    const waitForStage = (stage: Promise<void>, label: string) => Promise.race([
      stage,
      first.then(({ status, body }) => {
        throw new Error(`HTTP ${status} completed before ${label}: ${body.slice(0, 500)}`)
      }),
    ])
    try {
      await waitForStage(ssrStarted.promise, 'the selected Home SSR transform')
      expect(events).toEqual(['guard:/', 'load:home'])
      await waitForStage(clientPanelStarted.promise, 'the nested Panel client transform')
      // Client dependency work has reached the nested component even though the
      // route's SSR compilation/navigation cannot finish yet. No timing guess.
      expect(ssr.runner.evaluatedModules.getModuleById(homeId)?.evaluated).not.toBe(true)
      expect(transformed.get(`client:${homeId}`)).toBe(1)
      expect(transformed.get(`client:${panelId}`)).toBe(1)
      expect(transformed.has(`client:${unusedId}`)).toBe(false)
    } finally {
      allowSsr.resolve()
    }
    const response = await first
    expect(response.status).toBe(200)
    expect(response.body).toContain('Home-A one')
    expect(response.body).toContain('Panel-A widget-ready')
    const renderedStyles = styles(response.body)
    expect(renderedStyles).toContain(`${base}src/home.css`)
    expect(renderedStyles).toContain(`${base}src/panel.css`)
    expect(renderedStyles.some((url) => url.startsWith(`${base}src/Panel.vue?`) && url.includes('type=style'))).toBe(true)
    expect(renderedStyles.some((url) => url.includes('unused'))).toBe(false)
    expect(new Set(renderedStyles).size).toBe(renderedStyles.length)

    // Optimizer updates remain Vite-owned. Once its first crawl is settled,
    // unchanged requests reuse transforms and still create fresh request data.
    const warm = await page('/', 'two')
    expect(warm.body).toContain('Home-A two')
    const warmTransforms = [...transformed]
    const next = await page('/', 'three')
    expect(next.body).toContain('Home-A three')
    expect(styles(next.body)).toEqual(styles(warm.body))
    expect([...transformed]).toEqual(warmTransforms)

    // An actual watcher update to a lazy route's nested component must discard
    // the corresponding graph metadata, including at Vue acceptance boundaries.
    const panelModule = vite.environments.client.moduleGraph.getModuleById(panelId)!
    const previousInvalidation = panelModule.lastInvalidationTimestamp
    const previousHmr = panelModule.lastHMRTimestamp
    await writeFile(join(root, 'src/replacement.css'), '.panel { color: green }')
    await writeFile(join(root, 'src/Panel.vue'), sources['src/Panel.vue']
      .replace('Panel-A', 'Panel-B').replace('./panel.css', './replacement.css'))
    await expect.poll(() => panelModule.lastInvalidationTimestamp !== previousInvalidation || panelModule.lastHMRTimestamp !== previousHmr,
      { timeout: 10_000 }).toBe(true)
    await expect.poll(async () => (await page('/', 'updated')).body, { timeout: 10_000 }).toContain('Panel-B widget-ready')
    const updated = await page('/', 'updated')
    expect(styles(updated.body)).toContain(`${base}src/replacement.css`)
    expect(styles(updated.body)).not.toContain(`${base}src/panel.css`)
    expect(transformed.has(`ssr:${unusedId}`)).toBe(false)
    expect(transformed.has(`client:${unusedId}`)).toBe(false)
    const redirected = await page('/redirect', 'redirected')
    expect(redirected.body).toContain('Home-A redirected')
    expect(redirected.body).toContain('Panel-B widget-ready')
  }, 60_000)
})
