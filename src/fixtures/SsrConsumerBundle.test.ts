import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { build } from 'vite'
import { ssrBundleAudit, type inspectSsrBundle } from './SsrBundleAudit'
import { assertCompleteCriticalPayload, assertReviewedClientModules, PERFORMANCE_BUDGETS, productionClientDefines, sourceClientAliases } from './SsrPerformanceContracts'

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures')
const frameworkRoot = join(fixturesRoot, '..')

const SERVER_ONLY_MARKERS = [
  'SeoEndpoints',
  'createSeoEndpoints',
  'SsrSitemapConfig',
  'SsrSiteOriginRuntime',
  'defineSitemap',
  'node:fs',
  'node:path',
  'node:url',
  'from "fs"',
  "from 'fs'",
  'sitemap.config',
  '__vite-browser-external',
]

const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'constants',
  'crypto',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'module',
  'net',
  'os',
  'path',
  'querystring',
  'stream',
  'tls',
  'tty',
  'url',
  'util',
  'vm',
  'worker_threads',
  'zlib',
])

let productionOutDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    productionOutDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  )
  productionOutDirs = []
})

const collectJsFiles = async (root: string): Promise<string[]> => {
  const files: string[] = []
  const walk = async (dir: string) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
        files.push(path)
      }
    }
  }
  await walk(root)
  return files
}

const normalizeModuleId = (id: string): string => id.replace(/\\/g, '/')

const stripVirtualPrefix = (id: string): string =>
  normalizeModuleId(id).replace(/^\0+/, '')

const isViteBrowserExternalId = (id: string): boolean => {
  const normalized = stripVirtualPrefix(id)
  return (
    normalized.includes('__vite-browser-external') ||
    normalized.includes('vite-browser-external') ||
    normalized.includes('browser-external')
  )
}

const isNodeBuiltinId = (id: string): boolean => {
  const normalized = stripVirtualPrefix(id)
  const bare = normalized.replace(/^node:/, '').split('?', 1)[0] || ''
  return (
    normalized.startsWith('node:') ||
    NODE_BUILTINS.has(normalized) ||
    NODE_BUILTINS.has(bare) ||
    /polyfill-node|node-stdlib-browser|vite-plugin-node-polyfills/.test(
      normalized
    )
  )
}

const isServerOnlyModuleId = (id: string): boolean => {
  const normalized = stripVirtualPrefix(id)
  return (
    normalized.includes('/src/server/') ||
    normalized.includes('/src/deployment/') ||
    normalized.includes('/src/cli/') ||
    normalized.includes('/@vue/server-renderer/') ||
    /SsrServer(?:Route|Middleware|Response)Runtime/.test(normalized) ||
    /SsrApplicationRuntime|SsrServerResolution|SsrServerReactivity|SsrRequestObservation|SsrReconciliationFingerprint|SsrRuntimeLoadDiagnostics|SsrObservability/.test(normalized) ||
    normalized.includes('/extensions/seo/SeoEndpoints') ||
    normalized.includes('SsrSitemapConfig') ||
    normalized.includes('SsrSiteOriginRuntime') ||
    /SeoEndpoints/.test(normalized)
  )
}

const isForbiddenClientModuleId = (id: string): boolean =>
  isServerOnlyModuleId(id) || isNodeBuiltinId(id) || isViteBrowserExternalId(id)

type BuiltClientOutput = {
  output: Array<{
    type: string
    moduleIds?: string[]
    modules?: Record<string, unknown>
    imports: string[]
    dynamicImports: string[]
  }>
}

const collectClientGraph = (result: unknown) => {
  const outputs = (Array.isArray(result) ? result : [result]).filter(
    (item): item is BuiltClientOutput =>
      Boolean(item && typeof item === 'object' && item !== null && 'output' in item)
  )
  const moduleIds: string[] = []
  const imports: string[] = []
  for (const output of outputs) {
    for (const item of output.output) {
      if (item.type !== 'chunk') continue
      moduleIds.push(...(item.moduleIds ?? Object.keys(item.modules ?? {})))
      imports.push(...item.imports, ...item.dynamicImports)
    }
  }
  return { moduleIds, imports }
}

const buildClientBundle = async (fixtureName: string, developmentEnv = false) => {
  const fixtureRoot = join(fixturesRoot, fixtureName)
  const outDir = await mkdtemp(join(tmpdir(), `vue-ssr-lite-${fixtureName}-`))
  productionOutDirs.push(outDir)
  const audits: ReturnType<typeof inspectSsrBundle>[] = []
  const result = await build({
    root: fixtureRoot,
    configFile: join(fixtureRoot, 'vite.config.ts'),
    mode: 'production',
    define: {
      ...productionClientDefines,
      // Reproduce the reported mismatch between a build command and DEV=true.
      // The generated CSS handoff must be absent even in this environment.
      'import.meta.env.DEV': JSON.stringify(developmentEnv),
    },
    resolve: { alias: sourceClientAliases(frameworkRoot) },
    build: {
      outDir,
      emptyOutDir: true,
      minify: true,
    },
    plugins: [ssrBundleAudit(frameworkRoot, (audit) => audits.push(audit))],
    logLevel: 'error',
  })
  const files = await collectJsFiles(outDir)
  expect(files.length).toBeGreaterThan(0)
  const bundle = (
    await Promise.all(files.map((file) => readFile(file, 'utf8')))
  ).join('\n')
  console.info('[vue-ssr-lite] fixture critical JS/CSS:', JSON.stringify({
    fixture: fixtureName,
    entries: audits.flatMap((audit) => audit.entries.map(({ file, js, cssSizes, total, resourceCount, renderedLengthByOwner }) =>
      ({ file, js, cssSizes, total, resourceCount, renderedLengthByOwner }))),
  }))
  return { outDir, bundle, files, audits, graph: collectClientGraph(result) }
}

const buildReactivityProbe = async (name: 'probe' | 'control' | 'bootstrap-budget') => {
  const root = join(fixturesRoot, 'reactivity-consumer')
  const audits: ReturnType<typeof inspectSsrBundle>[] = []
  const result = await build({
    root,
    configFile: false,
    mode: 'production',
    define: productionClientDefines,
    resolve: { alias: sourceClientAliases(frameworkRoot) },
    plugins: [ssrBundleAudit(frameworkRoot, (audit) => audits.push(audit))],
    build: {
      write: false,
      minify: 'esbuild',
      rollupOptions: {
        input: join(root, `src/${name}.ts`),
        preserveEntrySignatures: 'strict',
        // An inspection build only. Normal consumer builds keep their natural
        // graph; here external peers make framework compression attributable.
        external: name === 'bootstrap-budget' ? ['vue', 'vue-router'] : [],
      },
    },
    logLevel: 'error',
  })
  expect(audits).toHaveLength(1)
  const audit = audits[0]!
  expect(audit.entries).toHaveLength(1)
  for (const id of [...collectClientGraph(result).moduleIds, ...collectClientGraph(result).imports]) {
    expect(isForbiddenClientModuleId(id), id).toBe(false)
  }
  return { audit, entry: audit.entries[0]! }
}

describe('consumer client bundle boundaries', () => {
  it('keeps server-only modules and development CSS handoff out of real consumer graphs', async () => {
    const [basic, advanced, reactivity] = await Promise.all([
      buildClientBundle('basic-consumer'),
      buildClientBundle('advanced-consumer'),
      buildClientBundle('reactivity-consumer', true),
    ])

    for (const { bundle, graph, audits } of [basic, advanced, reactivity]) {
      expect(graph.moduleIds.length).toBeGreaterThan(0)
      for (const marker of SERVER_ONLY_MARKERS) {
        expect(bundle).not.toContain(marker)
      }
      for (const id of [...graph.moduleIds, ...graph.imports]) {
        expect(isForbiddenClientModuleId(id)).toBe(false)
      }
      expect(audits.length).toBeGreaterThan(0)
      for (const audit of audits) {
        expect(audit.entries.length).toBeGreaterThan(0)
        assertReviewedClientModules(audit, frameworkRoot)
        const renderedExports = audit.chunks.flatMap((chunk) => chunk.modules.flatMap((module) => module.renderedExports))
        for (const name of ['createSsrResolutionController', 'installSsrRequestContextObservation', 'fingerprintSsrReconciliationState', 'fingerprintSsrReactivityValues', 'requestSsrReactivityPass', 'requestSsrReactivityEffectPass', 'registerSsrReactivitySource']) {
          expect(renderedExports).not.toContain(name)
        }
        expect(bundle).not.toContain('no-callback-consequence')
        expect(bundle).not.toContain('data-vue-ssr-lite-rendered-style')
        for (const entry of audit.entries) {
          assertCompleteCriticalPayload(entry)
        }
      }
    }

    expect(advanced.bundle).toContain('x-analytics-id')
    expect(advanced.bundle).toContain('UA-123456')
    expect(advanced.bundle).not.toMatch(/vue-ssr-lite\/server/)
    expect(reactivity.bundle).toContain('watcher-count:')
    expect(reactivity.audits.flatMap((audit) => audit.entries.flatMap((entry) => entry.frameworkModules)))
      .toContainEqual(expect.stringContaining('/SsrReactivityRuntime.ts'))
  }, 120_000)

  it('budgets the public watcher bridge against an equivalent native Vue consumer', async () => {
    const [probe, control] = await Promise.all([
      buildReactivityProbe('probe'), buildReactivityProbe('control'),
    ])
    assertReviewedClientModules(probe.audit, frameworkRoot)
    assertCompleteCriticalPayload(probe.entry)
    expect(control.entry.frameworkModules).toEqual([])
    // The watcher-only graph cannot start pulling in bootstrap, router, fetch,
    // serialization, or reconciliation. Barrel-only modules render no code.
    expect(probe.entry.frameworkModules.map((id) => id.slice(id.lastIndexOf('/') + 1)).sort())
      .toEqual(['SsrReactivityRuntime.ts', 'SsrRequestResolution.ts'])
    expect(probe.entry.js.gzip - control.entry.js.gzip)
      .toBeLessThanOrEqual(PERFORMANCE_BUDGETS.watcherAddedGzip)
    expect(probe.entry.js.bytes - control.entry.js.bytes)
      .toBeLessThanOrEqual(PERFORMANCE_BUDGETS.watcherAddedBytes)
    console.info('[vue-ssr-lite] watcher contribution:', JSON.stringify({
      nativeVue: control.entry.js, publicWatchers: probe.entry.js,
      addedGzip: probe.entry.js.gzip - control.entry.js.gzip,
      addedBytes: probe.entry.js.bytes - control.entry.js.bytes,
    }))
  }, 60_000)

  it('budgets actual compressed framework bootstrap with Vue peers externalized', async () => {
    const { audit, entry } = await buildReactivityProbe('bootstrap-budget')
    assertReviewedClientModules(audit, frameworkRoot)
    expect(entry.external.sort()).toEqual(['vue', 'vue-router'])
    expect(entry.css).toEqual([])
    expect(entry.js.gzip).toBeLessThanOrEqual(PERFORMANCE_BUDGETS.frameworkBootstrapGzip)
    expect(entry.js.bytes).toBeLessThanOrEqual(PERFORMANCE_BUDGETS.frameworkBootstrapBytes)
    expect(entry.frameworkModules).toContainEqual(expect.stringContaining('/SsrBrowserRuntime.ts'))
    expect(entry.frameworkModules).toContainEqual(expect.stringContaining('/SsrReactivityRuntime.ts'))
    console.info('[vue-ssr-lite] framework bootstrap (external Vue peers):', JSON.stringify(entry.js))
  }, 60_000)
})

describe('client bundle boundary detector', () => {
  it('rejects Vite browser-external virtual module IDs', () => {
    expect(isForbiddenClientModuleId('__vite-browser-external')).toBe(true)
    expect(isForbiddenClientModuleId('\0__vite-browser-external:fs')).toBe(true)
    expect(isForbiddenClientModuleId('\0__vite-browser-external:node:fs')).toBe(
      true
    )
    expect(isForbiddenClientModuleId('browser-external:fs')).toBe(true)
    expect(isForbiddenClientModuleId('/@id/__vite-browser-external:path')).toBe(
      true
    )
  })

  it('still rejects Node built-ins, polyfills, and server-only modules', () => {
    expect(isForbiddenClientModuleId('node:fs')).toBe(true)
    expect(isForbiddenClientModuleId('fs')).toBe(true)
    expect(isForbiddenClientModuleId('polyfill-node/fs')).toBe(true)
    expect(isForbiddenClientModuleId('/repo/src/server-routes/SsrServerRouteRuntime.ts')).toBe(true)
    expect(isForbiddenClientModuleId('/repo/src/deployment/vercel/VercelRuntime.ts')).toBe(true)
    expect(isForbiddenClientModuleId('/repo/src/SsrRequestObservation.ts')).toBe(true)
    expect(isForbiddenClientModuleId('/repo/src/SsrServerResolution.ts')).toBe(true)
    expect(isForbiddenClientModuleId('/repo/src/SsrServerReactivity.ts')).toBe(true)
    expect(isForbiddenClientModuleId('/repo/node_modules/@vue/server-renderer/dist/server-renderer.esm-bundler.js')).toBe(true)
    expect(
      isForbiddenClientModuleId('/repo/src/server/SsrSitemapConfig.ts')
    ).toBe(true)
    expect(isForbiddenClientModuleId('/repo/src/extensions/seo/SeoEndpoints.ts')).toBe(
      true
    )
  })

  it('accepts ordinary browser modules', () => {
    expect(isForbiddenClientModuleId('/repo/src/server-routes/defineServerRoutes.ts')).toBe(false)
    expect(isForbiddenClientModuleId('/repo/src/server-routes/defineServerMiddleware.ts')).toBe(false)
    expect(isForbiddenClientModuleId('/repo/src/index.ts')).toBe(false)
    expect(isForbiddenClientModuleId('/repo/src/SsrRequestResolution.ts')).toBe(false)
    expect(isForbiddenClientModuleId('/repo/src/extensions/seo/useSeo.ts')).toBe(
      false
    )
    expect(isForbiddenClientModuleId('vue')).toBe(false)
  })
})
