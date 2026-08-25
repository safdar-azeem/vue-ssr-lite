import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { createServer as createHttpServer, request as requestHttp } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { build, createServer, type ViteDevServer } from 'vite'
import { SSR_RUNTIME_VIRTUAL_ID } from '../SsrConfigCompileRuntime'
import {
  createSsrManagedServer,
  type SsrManagedServer,
} from '../server/SsrServerRuntime'
import { importSsrViteModule } from '../vite/SsrViteModuleRuntime'

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/request-assets-multi-app'
)

let devServer: ViteDevServer | undefined
let managedServer: SsrManagedServer | undefined
let productionOutDir = ''
let viteCacheDir = ''

afterEach(async () => {
  await managedServer?.close().catch(() => undefined)
  await devServer?.close()
  if (productionOutDir) await rm(productionOutDir, { recursive: true, force: true })
  if (viteCacheDir) await rm(viteCacheDir, { recursive: true, force: true })
  managedServer = undefined
  devServer = undefined
  productionOutDir = ''
  viteCacheDir = ''
})

const createFixtureViteServer = async () => {
  viteCacheDir = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-vite-cache-'))
  return createServer({
    root: fixtureRoot,
    configFile: join(fixtureRoot, 'vite.config.ts'),
    cacheDir: viteCacheDir,
    server: { middlewareMode: true, hmr: { server: createHttpServer() } },
    appType: 'custom',
  })
}

const responseHtml = async (host: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const request = requestHttp(
      {
        hostname: '127.0.0.1',
        port: managedServer!.address().port,
        path: '/lazy',
        headers: { accept: 'text/html', host },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const html = Buffer.concat(chunks).toString('utf8')
          if (response.statusCode !== 200) {
            reject(new Error(`Expected ${host} lazy response to succeed; received ${response.statusCode}: ${html}`))
            return
          }
          resolve(html)
        })
      }
    )
    request.on('error', reject)
    request.end()
  })

describe('request-aware multi-application assets', () => {
  it('isolates lazy route CSS in development', async () => {
    devServer = await createFixtureViteServer()
    managedServer = await createSsrManagedServer({
      production: false,
      root: fixtureRoot,
      vite: devServer,
      loadRuntime: () =>
        importSsrViteModule(devServer!, SSR_RUNTIME_VIRTUAL_ID),
    })
    await managedServer.listen()
    const [website, admin] = await Promise.all([
      responseHtml('website.localhost'),
      responseHtml('admin.localhost'),
    ])

    expect(website).toContain('WebsiteLazy.vue?vue')
    expect(website).not.toContain('AdminLazy.vue?vue')
    expect(admin).toContain('AdminLazy.vue?vue')
    expect(admin).not.toContain('WebsiteLazy.vue?vue')
  })

  it('isolates lazy route CSS and chunks through the shared production manifest', async () => {
    productionOutDir = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-multi-'))
    const base = '/products/'
    await build({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      base,
      build: { outDir: productionOutDir, emptyOutDir: true },
    })
    const manifest = JSON.parse(
      await readFile(join(productionOutDir, '.vite/ssr-manifest.json'), 'utf8')
    ) as Record<string, string[]>
    const websiteAssets = Object.entries(manifest).find(([id]) =>
      id.endsWith('src/website/WebsiteLazy.vue')
    )?.[1] ?? []
    const adminAssets = Object.entries(manifest).find(([id]) =>
      id.endsWith('src/admin/AdminLazy.vue')
    )?.[1] ?? []
    const websiteCss = websiteAssets.find((asset) => asset.endsWith('.css'))
    const websiteJs = websiteAssets.find((asset) => asset.endsWith('.js'))
    const adminCss = adminAssets.find((asset) => asset.endsWith('.css'))
    const adminJs = adminAssets.find((asset) => asset.endsWith('.js'))
    expect(websiteCss).toBeTruthy()
    expect(websiteJs).toBeTruthy()
    expect(adminCss).toBeTruthy()
    expect(adminJs).toBeTruthy()

    devServer = await createFixtureViteServer()
    const runtime = await importSsrViteModule<{
      default: () => Promise<{
        server?: Record<string, unknown>
        [key: string]: unknown
      }>
    }>(devServer, SSR_RUNTIME_VIRTUAL_ID)
    const loadedConfig = await runtime.default()
    managedServer = await createSsrManagedServer({
      production: true,
      root: fixtureRoot,
      loadRuntime: async () => ({
        default: {
          ...loadedConfig,
          server: {
            ...loadedConfig.server,
            port: 0,
            clientOutDir: productionOutDir,
          },
          resolveSiteUrl: () => 'https://example.com',
          __vueSsrLiteViteBase: base,
        },
      }),
    })
    await managedServer.listen()
    const [website, admin] = await Promise.all([
      responseHtml('website.test'),
      responseHtml('admin.test'),
    ])

    expect(website).toContain(`href="${websiteCss}"`)
    expect(website).toContain(`href="${websiteJs}"`)
    expect(website).not.toContain(adminCss!)
    expect(website).not.toContain(adminJs!)
    expect(admin).toContain(`href="${adminCss}"`)
    expect(admin).toContain(`href="${adminJs}"`)
    expect(admin).not.toContain(websiteCss!)
    expect(admin).not.toContain(websiteJs!)
  })
})
