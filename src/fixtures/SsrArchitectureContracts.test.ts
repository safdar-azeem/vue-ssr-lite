import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { build } from 'vite'
import {
  bundleSsrConfigModule,
  extractSsrViteEntries,
  generateSsrClientModule,
  generateSsrRuntimeModule,
  loadSsrConfigFile,
} from '../SsrConfigCompileRuntime'

const hybridRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/architecture-hybrid'
)
const multiRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/architecture-multi-domain'
)
const cleanRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/clean-consumer'
)

const vueSfcMarkers = [
  'HYBRID_LANDING_SFC',
  'HYBRID_ABOUT_SFC',
  'HYBRID_WORKSPACE_SFC',
  'WEBSITE_HOME_SFC',
  'ADMIN_DASHBOARD_SFC',
  'DOCS_GUIDE_SFC',
]

let productionOutDir = ''

afterEach(async () => {
  if (productionOutDir) {
    await rm(productionOutDir, { recursive: true, force: true })
  }
  productionOutDir = ''
})

describe('single-app architecture fixture', () => {
  it('loads conventional src/main.ts and src/App.vue without scanning applications', async () => {
    const config = await loadSsrConfigFile(cleanRoot)
    const entries = extractSsrViteEntries(config, { root: cleanRoot })
    expect(entries.applications).toEqual([
      expect.objectContaining({
        id: 'app',
        kind: 'ssr',
        main: './src/main.ts',
        root: './src/App.vue',
        routesFromMain: true,
      }),
    ])
    const client = generateSsrClientModule(cleanRoot, entries.applications[0])
    expect(client).toContain('hydrateSsrApplication')
    expect(client).toContain('/src/main.ts')
    expect(client).toContain('/src/App.vue')
    expect(client).toContain('const routes = __ssrMain.routes')
  })
})

describe('hybrid route-app architecture fixture', () => {
  it('loads hybrid server.ts without Vue SFC transformation', async () => {
    const { code } = await bundleSsrConfigModule(hybridRoot, join(hybridRoot, 'server.ts'))
    expect(code).not.toMatch(/No loader is configured for "\.vue"/)
    for (const marker of vueSfcMarkers.filter((marker) => marker.startsWith('HYBRID_'))) {
      expect(code).not.toContain(marker)
      expect(code).not.toContain('<template>')
    }
    const config = await loadSsrConfigFile(hybridRoot)
    const entries = extractSsrViteEntries(config, { root: hybridRoot })
    expect(entries.applications[0]).toMatchObject({
      id: 'app',
      kind: 'ssr',
      main: './src/main.ts',
      root: './src/App.vue',
      routesFromMain: true,
    })
  })
})

describe('multi-domain architecture fixture', () => {
  it('compiles server.ts -> app.ts -> routes.ts -> *.vue without pulling SFCs into esbuild', async () => {
    const { code } = await bundleSsrConfigModule(multiRoot, join(multiRoot, 'server.ts'))
    expect(code).not.toMatch(/No loader is configured for "\.vue"/)
    for (const marker of [
      'WEBSITE_HOME_SFC',
      'ADMIN_DASHBOARD_SFC',
      'DOCS_GUIDE_SFC',
      '<template>',
    ]) {
      expect(code).not.toContain(marker)
    }
    expect(code).not.toContain('var HomePage_default')
    expect(code).not.toContain('HomePage.vue')
    expect(code).toContain('WEBSITE_SERVER_ONLY_PROVIDER')
  })

  it('discovers explicit applications from evaluated modules, including aliased defineApplication', async () => {
    const config = await loadSsrConfigFile(multiRoot)
    const files = (config as { __vueSsrLiteApplicationFiles?: Map<string, string> })
      .__vueSsrLiteApplicationFiles
    const routes = (config as { __vueSsrLiteRoutesModules?: Map<string, string> })
      .__vueSsrLiteRoutesModules
    expect([...files!.keys()].sort()).toEqual(['admin', 'docs', 'website'])
    expect(files!.get('docs')).toContain('src/modules/docs/app.ts')
    expect(routes!.get('website')).toBe('./src/modules/website/routes.ts')
    expect(routes!.get('admin')).toBe('./src/modules/admin/routes.ts')
    expect(routes!.get('docs')).toBe('./src/modules/docs/routes.ts')
  })

  it('generates isolated client graphs and a shared-shell SSR runtime', async () => {
    const config = await loadSsrConfigFile(multiRoot)
    const entries = extractSsrViteEntries(config, { root: multiRoot })
    expect(entries.applications.map((app) => app.id)).toEqual([
      'website',
      'admin',
      'docs',
    ])
    const website = entries.applications[0]
    const admin = entries.applications[1]
    const docs = entries.applications[2]
    expect(website).toMatchObject({
      kind: 'ssr',
      main: './src/main.ts',
      root: './src/App.vue',
      routesModule: './src/modules/website/routes.ts',
      routesFromMain: false,
    })
    expect(admin).toMatchObject({
      kind: 'spa',
      main: './src/main.ts',
      root: './src/App.vue',
      routesModule: './src/modules/admin/routes.ts',
      routesFromMain: false,
    })
    expect(docs).toMatchObject({
      kind: 'ssr',
      main: './src/modules/docs/main.ts',
      root: './src/modules/docs/App.vue',
      routesModule: './src/modules/docs/routes.ts',
      applicationFile: expect.stringContaining('src/modules/docs/app.ts'),
    })

    const websiteClient = generateSsrClientModule(multiRoot, website)
    const adminClient = generateSsrClientModule(multiRoot, admin)
    const docsClient = generateSsrClientModule(multiRoot, docs)
    expect(websiteClient).toContain('modules/website/routes.ts')
    expect(websiteClient).not.toContain('modules/admin/')
    expect(websiteClient).not.toContain('modules/docs/')
    expect(websiteClient).not.toContain('modules/website/app.ts')
    expect(websiteClient).not.toContain('WEBSITE_SERVER_ONLY_PROVIDER')
    expect(adminClient).toContain('mountSpaApplication')
    expect(adminClient).toContain('modules/admin/routes.ts')
    expect(adminClient).not.toContain('modules/website/routes.ts')
    expect(adminClient).not.toContain('modules/admin/app.ts')
    expect(docsClient).toContain('modules/docs/routes.ts')
    expect(docsClient).toContain('modules/docs/App.vue')
    expect(docsClient).toContain('modules/docs/main.ts')
    expect(docsClient).not.toContain('modules/website/routes.ts')
    expect(websiteClient).toContain('/src/App.vue')
    expect(adminClient).toContain('/src/App.vue')
    expect(websiteClient).toContain('/src/main.ts')
    expect(adminClient).toContain('/src/main.ts')

    const runtime = generateSsrRuntimeModule(
      multiRoot,
      join(multiRoot, 'server.ts'),
      entries.applications
    )
    expect(runtime).toContain('/src/App.vue')
    expect(runtime).toContain('/src/main.ts')
    expect(runtime).toContain('/src/modules/docs/App.vue')
    expect(runtime).toContain('/src/modules/docs/main.ts')
    expect(runtime.match(/import __ssrRoot\d+_website from/g)?.length ?? 0).toBe(1)
    expect(runtime).not.toContain('modules/admin/pages')
    expect(runtime).not.toContain('ADMIN_SERVER_ONLY_PROVIDER')
  })

  it('does not eagerly put unrelated application pages or server-only providers in browser chunks', async () => {
    productionOutDir = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-multi-arch-'))
    await build({
      root: multiRoot,
      configFile: join(multiRoot, 'vite.config.ts'),
      build: { outDir: productionOutDir, emptyOutDir: true },
    })
    const files = await readdir(productionOutDir, { recursive: true })
    const jsFiles = files.filter((file) => file.endsWith('.js'))
    const chunks: Record<string, string> = {}
    for (const file of jsFiles) {
      chunks[file] = await readFile(join(productionOutDir, file), 'utf8')
    }
    const allJs = Object.values(chunks).join('\n')
    expect(allJs).not.toContain('WEBSITE_SERVER_ONLY_PROVIDER')
    expect(allJs).not.toContain('ADMIN_SERVER_ONLY_PROVIDER')
    const websiteChunk = Object.values(chunks).find((code) =>
      code.includes('WEBSITE_HOME_SFC')
    )
    const adminChunk = Object.values(chunks).find((code) =>
      code.includes('ADMIN_DASHBOARD_SFC')
    )
    const docsChunk = Object.values(chunks).find((code) =>
      code.includes('DOCS_GUIDE_SFC')
    )
    expect(websiteChunk).toBeTruthy()
    expect(adminChunk).toBeTruthy()
    expect(docsChunk).toBeTruthy()
    expect(websiteChunk).not.toContain('ADMIN_DASHBOARD_SFC')
    expect(websiteChunk).not.toContain('DOCS_GUIDE_SFC')
    expect(adminChunk).not.toContain('WEBSITE_HOME_SFC')
    expect(adminChunk).not.toContain('DOCS_GUIDE_SFC')
    expect(docsChunk).not.toContain('WEBSITE_HOME_SFC')
    expect(docsChunk).not.toContain('ADMIN_DASHBOARD_SFC')
  })
})
