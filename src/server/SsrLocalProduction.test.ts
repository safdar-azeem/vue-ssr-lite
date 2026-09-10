import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { defineServer } from '../SsrConfigRuntime'
import { withSsrShells } from '../SsrTestFixtures'
import { createSsrManagedServer, type SsrManagedServer } from './SsrServerRuntime'

let root = ''
let managed: SsrManagedServer | undefined
beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('PUBLIC_URL', '')
  vi.stubEnv('PORT', '')
  vi.stubEnv('HOST', '')
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  root = await mkdtemp(join(tmpdir(), 'ssr-local-production-'))
  await mkdir(join(root, 'dist/client/.vite'), { recursive: true })
  await writeFile(join(root, 'dist/client/index.html'), '<!doctype html><html><head></head><body><div id="app"></div></body></html>')
  await writeFile(join(root, 'dist/client/.vite/manifest.json'), '{}')
  await writeFile(join(root, 'dist/client/.vite/ssr-manifest.json'), '{}')
  await writeFile(join(root, 'dist/client/.vite/vue-ssr-lite-assets.json'), '{"version":1,"immutable":[]}')
  await writeFile(join(root, 'dist/client/favicon.ico'), 'icon')
})
afterEach(async () => {
  await managed?.close()
  managed = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const get = (hostname: string, host: string, path: string, method = 'GET', headers = {}) =>
  new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
    const request = httpRequest({
      hostname, port: managed!.address().port, path, method, agent: false,
      headers: { host, accept: 'text/html', ...headers },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.once('error', reject)
      response.once('end', () => resolveResponse({ status: response.statusCode!, body }))
    })
    request.once('error', reject)
    request.end()
  })

describe('zero-configuration managed Node production', () => {
  it.each([
    { peer: '127.0.0.1', host: 'localhost' },
    { peer: '127.0.0.1', host: '127.0.0.1' },
    { peer: '::1', host: '[::1]' },
  ])('serves unchanged SSR configuration over $host with an actual $peer connection', async ({ peer, host }) => {
    const config = defineServer({ render: 'ssr' })
    const Root = defineComponent({ setup: () => () => h('main', 'local production SSR') })
    managed = await createSsrManagedServer({
      production: true, root,
      // Only the test harness selects an isolated bind address/ephemeral port.
      // Consumer configuration contains no SEO, origin or deployment options.
      loadRuntime: async () => withSsrShells({ ...config, server: { host: peer, port: 0 } }, { app: { root: Root } }),
    })
    await managed.listen()
    const authority = `${host}:${managed.address().port}`
    const html = await get(peer, authority, '/')
    expect(html.status).toBe(200)
    expect(html.body).toContain('<main>local production SSR</main>')
    expect(html.body).toContain(`http://${authority}`)
    expect(html.body).not.toMatch(/trustedLocalConnection|trusted-local-origin/)
    expect(await get(peer, authority, '/favicon.ico')).toEqual({ status: 200, body: 'icon' })
    expect(await get(peer, authority, '/', 'HEAD')).toEqual({ status: 200, body: '' })
    expect(await get(peer, authority, '/favicon.ico', 'HEAD')).toEqual({ status: 200, body: '' })

    // Warm local success cannot grant later public/proxied requests permission.
    expect((await get(peer, 'example.com', '/')).status).toBe(500)
    expect((await get(peer, authority, '/', 'GET', { 'x-forwarded-for': '198.51.100.2' })).status).toBe(500)
    expect((await get(peer, authority, '/')).status).toBe(200)
  })
})
