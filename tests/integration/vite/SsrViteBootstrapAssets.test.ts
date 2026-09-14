import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { build, type Rollup, type UserConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vueSsrLite } from '../../../src/vite/SsrVitePlugin'
import { provisionHostVuePeers } from '../../helpers/SsrTestFixtures'
import { sourceClientAliases, productionClientDefines } from '../../../tools/audits/SsrPerformanceContracts'
import { createSsrBootstrapAssetResolver, parseSsrBootstrapAssetManifest, SSR_BROWSER_BOOTSTRAP_METADATA_PATH } from '../../../src/assets/SsrBootstrapAssetRuntime'
import { parseSsrProductionAssetMetadata, SSR_PRODUCTION_ASSET_METADATA_PATH } from '../../../src/assets/SsrAssetMetadata'
import { collectDeploymentStaticAssets } from '../../../src/deployment/DeploymentAssets'
import { injectSsrRenderedAssets } from '../../../src/rendering/SsrHtmlRuntime'
import { readSsrHtmlAttributes } from '../../../src/rendering/SsrHtmlParsing'

const frameworkRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** Real Vite/Vue source fixture, run only by the user's test invocation. */
const fixture = async (run: (root: string) => Promise<void>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bootstrap-assets-')))
  try {
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'public'))
    await provisionHostVuePeers(root)
    const files = {
      'server.ts': 'export default { seo: { enabled: true, siteUrl: "https://bootstrap.test" } }',
      'index.html': '<html><head></head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>',
      'src/main.ts': 'export default () => {}',
      'src/App.vue': `<script setup>
        import { defineAsyncComponent } from 'vue'
        const CookiesNotice = defineAsyncComponent(() => import('./CookiesNotice.vue'))
        const CookieDetails = defineAsyncComponent(() => import('./CookieDetails.vue'))
        </script><template><main>Home<CookiesNotice /><CookieDetails /></main></template>`,
      'src/CookiesNotice.vue': '<template><aside class="notice">Cookies</aside></template><style scoped>.notice { color: navy }</style>',
      'src/CookieDetails.vue': '<template><aside class="details">Details</aside></template><style scoped>.details { color: green }</style>',
      'public/copied-AbCd1234.css': '.copied { color: red }',
    }
    await Promise.all(Object.entries(files).map(([path, text]) => writeFile(join(root, path), text)))
    await run(root)
  } finally { await rm(root, { recursive: true, force: true }) }
}

const stylesheetHrefs = (html: string) => [...html.matchAll(/<link\b([^>]*)>/gi)].flatMap(([, attributes]) => {
  const values = new Map(readSsrHtmlAttributes(attributes!))
  return values.get('rel')?.toLowerCase().split(/\s+/).includes('stylesheet') ? [values.get('href')] : []
})

const verifyFixtureAssets = async (root: string, outDir: string, base: string) => {
  const manifest = JSON.parse(await readFile(join(outDir, '.vite/manifest.json'), 'utf8')) as Record<string, {
    file: string; css?: string[]; isDynamicEntry?: boolean
  }>
  const generatedCss = [...new Set(Object.values(manifest).flatMap((entry) => entry.css ?? []))]
  expect(generatedCss.length).toBeGreaterThan(0)
  const immutable = parseSsrProductionAssetMetadata(await readFile(join(outDir, SSR_PRODUCTION_ASSET_METADATA_PATH), 'utf8'))
  for (const file of generatedCss) expect(immutable.has(file), file).toBe(true)
  expect(immutable.has('copied-AbCd1234.css')).toBe(false)
  const deployment = await collectDeploymentStaticAssets(outDir, { version: 1, viteBase: base, templates: ['index.html'],
    dynamicAssets: false, serverRouteMatchers: [], controlPaths: [] })
  for (const file of generatedCss) expect(deployment.find((asset) => asset.file === file)?.cacheControl).toBe('public, max-age=31536000, immutable')
  expect(deployment.find((asset) => asset.file === 'copied-AbCd1234.css')?.cacheControl).toBe('public, max-age=3600')
  expect(deployment.some((asset) => asset.file.includes('.vite'))).toBe(false)

  const bootstrap = parseSsrBootstrapAssetManifest(await readFile(join(outDir, SSR_BROWSER_BOOTSTRAP_METADATA_PATH), 'utf8'))
  expect(bootstrap.applications.app!.initial).toEqual(['extensions', 'seo'])
  expect(bootstrap.applications.app!.capabilities.seo!.length).toBeGreaterThan(0)
  for (const application of Object.values(bootstrap.applications)) {
    for (const file of Object.values(application.capabilities).flatMap((files) => files ?? [])) {
      expect(file).toMatch(/\.(?:js|mjs)$/)
      expect(file).not.toMatch(/\.css$/)
    }
  }
  const template = await readFile(join(outDir, 'index.html'), 'utf8')
  const links = createSsrBootstrapAssetResolver(bootstrap, base)('app')
  expect(links.length).toBeGreaterThan(0)
  for (const link of links) {
    expect(link.applicationId).toBe('app')
    expect(link.rel).toBe('modulepreload')
    expect(link.href).toMatch(/\.(?:js|mjs)$/)
    expect(link.href).not.toMatch(/\.css$/)
  }
  const html = injectSsrRenderedAssets(template, links)
  for (const link of links) expect(html).toContain(`href="${link.href}"`)
  // Preserve Vite's stylesheet decisions, including any consumer manual chunks.
  // Compare arrays so even an added duplicate stylesheet fails this contract.
  expect(stylesheetHrefs(html)).toEqual(stylesheetHrefs(template))
  expect(JSON.stringify(bootstrap)).not.toContain(root)
  return { manifest, generatedCss, template, html }
}

describe('real Vite bootstrap and lazy CSS provenance', () => {
  it.each(['/', '/products/', 'https://cdn.example.test/products/'])('keeps dynamically imported Vue CSS lazy and immutable under %s', async (base) => fixture(async (root) => {
    const outDir = join(root, 'output')
    let outputCss: string[] = []
    await build({
      root, base, configFile: false, logLevel: 'silent', mode: 'production', define: productionClientDefines,
      resolve: { alias: sourceClientAliases(frameworkRoot) },
      plugins: [vueSsrLite({ root }), vue(), {
        name: 'observe-real-lazy-css',
        generateBundle(_options, bundle) {
          outputCss = Object.values(bundle).filter((item): item is Rollup.OutputAsset =>
            item.type === 'asset' && item.fileName.endsWith('.css')
          ).map((item) => item.fileName)
        },
      }],
      build: { outDir },
    })
    const { manifest, generatedCss, template, html } = await verifyFixtureAssets(root, outDir, base)
    // Use source-owned dynamic entries to identify the lazy CSS, not hashed names.
    for (const source of ['src/CookiesNotice.vue', 'src/CookieDetails.vue']) {
      const entry = manifest[source]
      expect(entry?.isDynamicEntry, source).toBe(true)
      const lazyCss = entry?.css ?? []
      expect(lazyCss.length, source).toBeGreaterThan(0)
      for (const file of lazyCss) {
        expect(outputCss).toContain(file)
        expect(generatedCss).toContain(file)
        expect(template).not.toContain(file)
        expect(html).not.toContain(file)
      }
    }
  }), 60_000)

  it.each(['/', '/products/', 'https://cdn.example.test/products/'])('tracks facade-less shared CSS provenance under %s', async (base) => fixture(async (root) => {
    const outDir = join(root, 'output')
    let facadeLessCss: string[] = []
    await build({
      root, base, configFile: false, logLevel: 'silent', mode: 'production', define: productionClientDefines,
      resolve: { alias: sourceClientAliases(frameworkRoot) },
      plugins: [vueSsrLite({ root }), vue(), {
        name: 'observe-real-css-provenance',
        generateBundle(_options, bundle) {
          facadeLessCss = Object.values(bundle).filter((item): item is Rollup.OutputAsset =>
            item.type === 'asset' && item.fileName.endsWith('.css') && item.originalFileNames.length === 0
          ).map((item) => item.fileName)
        },
      }],
      build: { outDir, rollupOptions: { output: {
        // Exercise the missing-facade case using normal consumer chunking. The
        // framework itself never supplies manualChunks.
        manualChunks(id) { if (/\/Cookie(?:sNotice|Details)\.vue(?:\?|$)/.test(id)) return 'cookie-widgets' },
      } } },
    })
    const { generatedCss } = await verifyFixtureAssets(root, outDir, base)
    expect(facadeLessCss.length).toBeGreaterThan(0)
    // These actual outputs have no original-file ownership, but must still be
    // represented in the manifest whose immutable metadata/caching we verified.
    for (const file of facadeLessCss) expect(generatedCss).toContain(file)
  }), 60_000)

  it.each(['false', 'callback'] as const)('preserves Vite modulePreload=%s and keeps dynamic execution', async (policy) => fixture(async (root) => {
    const resolveDependencies = vi.fn((_file: string, dependencies: string[]) => dependencies.filter((file) => file.endsWith('.js')))
    const modulePreload: NonNullable<UserConfig['build']>['modulePreload'] = policy === 'false' ? false : { resolveDependencies }
    const outDir = join(root, 'output')
    const outputs: string[] = []
    await build({ root, configFile: false, logLevel: 'silent', mode: 'production', define: productionClientDefines,
      resolve: { alias: sourceClientAliases(frameworkRoot) },
      plugins: [vueSsrLite({ root }), vue(), { name: 'observe-dynamic-imports', generateBundle(_options, bundle) {
        outputs.push(...Object.values(bundle).flatMap((item) => item.type === 'chunk' ? [item.code] : []))
      } }], build: { outDir, modulePreload } })
    const manifest = parseSsrBootstrapAssetManifest(await readFile(join(outDir, SSR_BROWSER_BOOTSTRAP_METADATA_PATH), 'utf8'))
    expect(manifest.policy).toBe(policy === 'false' ? 'disabled' : 'resolve-dependencies')
    expect(createSsrBootstrapAssetResolver(manifest, '/')('app', ['middleware'])).toEqual([])
    expect(outputs.join('\n')).toContain('import(')
    if (policy === 'callback') {
      expect(modulePreload).toEqual({ resolveDependencies })
      expect(resolveDependencies).toHaveBeenCalled()
      const callsAfterBuild = resolveDependencies.mock.calls.length
      createSsrBootstrapAssetResolver(manifest, '/')('app')
      expect(resolveDependencies).toHaveBeenCalledTimes(callsAfterBuild)
    }
  }), 60_000)
})
