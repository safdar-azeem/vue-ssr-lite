import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, isRunnableDevEnvironment, type ViteDevServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { SSR_RUNTIME_VIRTUAL_ID } from '../SsrConfigCompileRuntime'
import { closeViteDevServer, provisionHostVuePeers } from '../SsrTestFixtures'
import { createSsrManagedServer, type SsrManagedServer } from '../server/SsrServerRuntime'
import { SSR_HTML_MARKER } from '../server/SsrHtmlRuntime'
import { captureSsrViteRuntimeRevision, importSsrViteModule } from './SsrViteModuleRuntime'
import { vueSsrLite } from './SsrVitePlugin'

let root = ''
let vite: ViteDevServer | undefined
let managed: SsrManagedServer | undefined
let hmr: Server | undefined

afterEach(async () => {
  await managed?.close()
  await closeViteDevServer(vite, hmr)
  managed = undefined
  vite = undefined
  hmr = undefined
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  root = ''
})

describe('runtime revisions through real Vite HMR', () => {
  it.each(['/', '/products/'])('keeps shell, routes, configuration and HTML hooks live under base %s', async (base) => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-live-revision-'))
    await mkdir(join(root, 'src'))
    await provisionHostVuePeers(root)
    const sources = {
      'index.html': '<html><head></head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>',
      'server.ts': `import { publicConfig } from './application'
        export default { publicConfig, server: { port: 0, diagnostics: false } }`,
      'application.ts': `export const publicConfig = { version: 'config-A' }`,
      'src/main.ts': `export { routes } from './routes'
        export default ({ app }) => { app.provide('main-marker', 'main-A') }`,
      'src/routes.ts': `import { h } from 'vue'
        export const routes = [
          { path: '/:pathMatch(.*)*', component: { render: () => h('p', 'route-A') } },
          { path: '/lazy', component: () => import('./Lazy.vue') }
        ]`,
      'src/App.vue': `<script setup>
        import { inject } from 'vue'
        import { RouterView } from 'vue-router'
        import { usePublicConfig } from 'vue-ssr-lite'
        const main = inject('main-marker')
        const config = usePublicConfig()
        </script><template><main>App-A {{ main }} {{ config.version }}<RouterView /></main></template>`,
      'src/Lazy.vue': `<script setup>import './lazy.css'</script><template><p>lazy page</p></template>`,
      'src/lazy.css': '.lazy-page { color: purple }',
    }
    await Promise.all(Object.entries(sources).map(([file, source]) => writeFile(join(root, file), source)))
    const before: { url: string; prepared: boolean }[] = []
    const after: string[] = []
    let nonce = 0
    hmr = createHttpServer()
    vite = await createServer({
      root, base, configFile: false, logLevel: 'silent',
      resolve: { alias: {
        'vue-ssr-lite/client': fileURLToPath(new URL('../client.ts', import.meta.url)),
        'vue-ssr-lite/server': fileURLToPath(new URL('../server.ts', import.meta.url)),
        'vue-ssr-lite': fileURLToPath(new URL('../index.ts', import.meta.url)),
      } },
      plugins: [
        {
          name: 'request-specific-pre-html', enforce: 'pre',
          transformIndexHtml: { order: 'pre', handler(html, context) {
            const url = (context as { originalUrl?: string }).originalUrl ?? context.path
            before.push({ url, prepared: html.includes(SSR_HTML_MARKER) })
            return html.replace('</head>', `<meta name="nonce" content="${++nonce}"><meta name="request" content="${url}"></head>`)
          } },
        },
        vueSsrLite({ root }), vue(),
        {
          name: 'request-specific-post-html',
          transformIndexHtml: { order: 'post', handler(html, context) {
            const url = (context as { originalUrl?: string }).originalUrl ?? context.path
            after.push(url)
            return url === '/invalid-mount'
              ? html.replace('</body>', '<div id="app"></div></body>')
              : html.replace('<div id="app"', `<div data-request="${url}" id="app"`)
          } },
        },
      ],
      server: { middlewareMode: true, hmr: { server: hmr } }, appType: 'custom',
    })
    const loadRuntime = vi.fn(() => importSsrViteModule(vite!, SSR_RUNTIME_VIRTUAL_ID))
    managed = await createSsrManagedServer({ production: false, root, vite, loadRuntime })
    await managed.listen()
    const page = (path = '/') => new Promise<{ status: number; body: string }>((resolveResponse, rejectResponse) => {
      const req = request({ hostname: '127.0.0.1', port: managed!.address().port, path, agent: false,
        headers: { host: 'localhost', accept: 'text/html' } }, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { body += chunk })
        response.on('error', rejectResponse)
        response.on('end', () => resolveResponse({ status: response.statusCode!, body }))
      })
      req.on('error', rejectResponse)
      req.end()
    })
    const initial = await page('/one')
    const initialLoads = loadRuntime.mock.calls.length
    const warm = await page('/two')
    expect(initial.status).toBe(200)
    expect(warm.status).toBe(200)
    expect(initial.body).toContain('content="/one"')
    expect(initial.body).toContain('name="nonce" content="1"')
    expect(warm.body).toContain('name="nonce" content="2"')
    expect(warm.body).toContain('data-request="/two"')
    expect(before).toEqual([{ url: '/one', prepared: false }, { url: '/two', prepared: false }])
    expect(after).toEqual(['/one', '/two'])
    expect(loadRuntime).toHaveBeenCalledTimes(initialLoads)
    const ssr = vite.environments.ssr
    if (!isRunnableDevEnvironment(ssr)) throw new Error('Expected Vite to own a runnable SSR environment.')
    expect(ssr.runner.evaluatedModules.getModuleById(join(root, 'src/Lazy.vue'))?.evaluated).not.toBe(true)
    expect(warm.body).not.toContain('/src/lazy.css')

    // Observe the real watcher and public graph. No manual invalidation,
    // restart, stale timers, or fixed sleep stands in for a completed update.
    for (const [file, previous, next] of [
      ['src/App.vue', 'App-A', 'App-B'],
      ['src/main.ts', 'main-A', 'main-B'],
      ['src/routes.ts', 'route-A', 'route-B'],
      ['application.ts', 'config-A', 'config-B'],
    ] as const) {
      const loaded = await importSsrViteModule(vite, SSR_RUNTIME_VIRTUAL_ID)
      const current = captureSsrViteRuntimeRevision(vite, loaded)
      expect(current?.()).toBe(true)
      await writeFile(join(root, file), sources[file].replace(previous, next))
      await expect.poll(() => current?.(), { timeout: 10_000 }).toBe(false)
      await expect.poll(async () => (await page()).body, { timeout: 10_000 }).toContain(next)
    }
    const updated = await page()
    for (const marker of ['App-B', 'main-B', 'route-B', 'config-B']) expect(updated.body).toContain(marker)
    const loads = loadRuntime.mock.calls.length
    await page()
    expect(loadRuntime).toHaveBeenCalledTimes(loads)
    const invalid = await page('/invalid-mount')
    expect(invalid.status).toBe(500)
    expect(invalid.body).toContain('appears more than once')
    expect((await page('/valid-again')).status).toBe(200)
  }, 60_000)
})
