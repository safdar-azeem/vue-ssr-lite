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
import { ssrBundleAudit, type inspectSsrBundle } from './SsrBundleAudit'
import { assertCompleteCriticalPayload, assertReviewedClientModules, productionClientDefines, sourceClientAliases } from './SsrPerformanceContracts'

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/request-assets-multi-app'
)
const frameworkRoot = join(fixtureRoot, '../..')

const criticalHtmlAssets = (html: string, base: string) => {
  const scripts: string[] = []
  const styles: string[] = []
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w-]+)=["']([^"']*)["']/g)]
      .map(([, key, value]) => [key, value]))
    if (attributes.type === 'module' && attributes.src) scripts.push(attributes.src)
    if (attributes.rel === 'modulepreload' && attributes.href) scripts.push(attributes.href)
    if (attributes.rel === 'stylesheet' && attributes.href) styles.push(attributes.href)
  }
  expect(new Set(scripts).size).toBe(scripts.length)
  expect(new Set(styles).size).toBe(styles.length)
  for (const asset of [...scripts, ...styles]) expect(asset.startsWith(base), asset).toBe(true)
  return { scripts: scripts.map((file) => file.slice(base.length)), styles: styles.map((file) => file.slice(base.length)) }
}

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
  // Cold Vite startup, dependency optimization, and two SSR module graphs
  // need the same integration budget as the production fixture below.
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
  }, 30_000)

  it('isolates lazy route CSS and chunks through the shared production manifest', async () => {
    productionOutDir = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-multi-'))
    const base = '/products/'
    const audits: ReturnType<typeof inspectSsrBundle>[] = []
    await build({
      root: fixtureRoot,
      configFile: join(fixtureRoot, 'vite.config.ts'),
      base,
      mode: 'production',
      define: productionClientDefines,
      resolve: { alias: sourceClientAliases(frameworkRoot) },
      plugins: [ssrBundleAudit(frameworkRoot, (audit) => audits.push(audit))],
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
    expect(audits.length).toBeGreaterThan(0)
    for (const audit of audits) {
      assertReviewedClientModules(audit, frameworkRoot)
      const websiteFile = websiteJs!.slice(base.length)
      const adminFile = adminJs!.slice(base.length)
      for (const entry of audit.entries) {
        assertCompleteCriticalPayload(entry)
        expect(entry.files).not.toContain(websiteFile)
        expect(entry.files).not.toContain(adminFile)
        const modules = audit.chunks.filter((chunk) => entry.files.includes(chunk.file))
          .flatMap((chunk) => chunk.modules).filter((module) => module.renderedLength > 0)
        const websiteOwned = modules.some((module) => module.id.replaceAll('\\', '/').includes('/src/website/'))
        const adminOwned = modules.some((module) => module.id.replaceAll('\\', '/').includes('/src/admin/'))
        expect(websiteOwned && adminOwned).toBe(false)
        expect(websiteOwned || adminOwned).toBe(true)
        const ownAssets = websiteOwned ? websiteAssets : adminAssets
        const otherAssets = websiteOwned ? adminAssets : websiteAssets
        const page = audit.critical(
          [entry.file, ...ownAssets.filter((file) => file.endsWith('.js')).map((file) => file.slice(base.length))],
          ownAssets.filter((file) => file.endsWith('.css')).map((file) => file.slice(base.length))
        )
        assertCompleteCriticalPayload(page)
        // These fixtures each add exactly one lazy SFC and its stylesheet.
        // Shared imports can be split freely; unrelated routes cannot join them.
        expect(page.files.filter((file) => !entry.files.includes(file))).toHaveLength(1)
        expect(page.css.filter((file) => !entry.css.includes(file))).toHaveLength(1)
        for (const asset of otherAssets.filter((file) => /\.(?:js|css)$/.test(file))) {
          expect([...page.files, ...page.css]).not.toContain(asset.slice(base.length))
        }
      }
      expect(audit.critical([websiteFile]).files).not.toContain(adminFile)
      expect(audit.critical([adminFile]).files).not.toContain(websiteFile)
    }

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
    for (const audit of audits) {
      for (const [html, ownAssets] of [[website, websiteAssets], [admin, adminAssets]] as const) {
        const actual = criticalHtmlAssets(html, base)
        const entry = audit.entries.find((candidate) => actual.scripts.includes(candidate.file))
        expect(entry).toBeDefined()
        const expected = audit.critical(
          [entry!.file, ...ownAssets.filter((file) => file.endsWith('.js')).map((file) => file.slice(base.length))],
          ownAssets.filter((file) => file.endsWith('.css')).map((file) => file.slice(base.length))
        )
        const delivered = audit.critical(actual.scripts, actual.styles)
        assertCompleteCriticalPayload(delivered)
        expect([...delivered.files].sort()).toEqual([...expected.files].sort())
        expect([...delivered.css].sort()).toEqual([...expected.css].sort())
        expect(delivered.total).toEqual(expected.total)
        expect(delivered.resourceCount).toBe(expected.resourceCount)
        console.info('[vue-ssr-lite] request-specific critical JS/CSS:', JSON.stringify({
          entry: entry!.file, files: delivered.files, css: delivered.css,
          js: delivered.js, cssSizes: delivered.cssSizes, total: delivered.total,
          resourceCount: delivered.resourceCount,
        }))
      }
    }
  }, 30_000)
})
