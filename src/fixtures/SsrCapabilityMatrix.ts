import { builtinModules, createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'vite'
import { SSR_BROWSER_BOOTSTRAP_SOURCES, type SsrBrowserBootstrapCapability } from '../SsrBrowserBootstrap'
import { ssrBundleAudit, type inspectSsrBundle } from './SsrBundleAudit'
import {
  BROWSER_ACTIVATION_SOURCES, CAPABILITY_PROFILES, type CapabilityProfile,
  assertAttributedClientModules, assertBrowserActivationAccounting, assertCapabilityGraph, assertCapabilityPagePayload,
  assertInstalledCapabilityParity, productionClientDefines, retainedFrameworkSources, sourceClientAliases,
} from './SsrPerformanceContracts'

type Audit = ReturnType<typeof inspectSsrBundle>
type Payload = ReturnType<Audit['critical']>
interface CapabilityRow {
  profile: CapabilityProfile
  externalPeers: boolean
  mode: 'source' | 'installed'
  activationSources: string[]
  activationFiles: string[]
  routeFiles: string[]
  criticalBootstrap: ReturnType<Audit['bootstrapReport']>
  bootstrapManifest: ReturnType<Audit['bootstrapManifest']>
  bootstrapCapabilitySources: Record<string, string[]>
  entryStatic: Payload
  bootstrap: Payload
  route: Payload
  page: Payload
  frameworkSources: string[]
  entryFrameworkSources: string[]
  bootstrapFrameworkSources: string[]
  chunks: Audit['chunks']
  stylesheets: Audit['stylesheets']
}
const nodeImports = new Set(builtinModules.flatMap((id) => [id, `node:${id}`]))

export const assertNoServerClientGraph = (audit: Audit): void => {
  for (const chunk of audit.chunks) {
    for (const id of [...chunk.imports, ...chunk.dynamicImports, ...chunk.modules.map((module) => module.id)]) {
      if (nodeImports.has(id) || id.startsWith('node:') || /browser-external|polyfill-node|node-stdlib-browser|@vue\/server-renderer/.test(id)) {
        throw new Error(`Forbidden client dependency: ${id}`)
      }
    }
  }
  assertAttributedClientModules(audit)
}

export interface CapabilityMatrixOptions {
  frameworkRoot: string
  /** Fixtures copied here for smoke; resolution is through its installed npm package. */
  consumerRoot: string
  fixtureRoot: string
  mode: 'source' | 'installed'
  reportPath?: string
}

/** Used by source coverage and npm smoke, with identical fixtures, peers and accounting. */
export const buildSsrCapabilityMatrix = async (options: CapabilityMatrixOptions) => {
  const require = createRequire(join(options.consumerRoot, 'package.json'))
  const moduleSources = options.mode === 'installed'
    ? JSON.parse(await readFile(join(options.consumerRoot, 'node_modules/vue-ssr-lite/dist/module-attribution.json'), 'utf8')).modules
    : undefined
  const dependencies = Object.fromEntries(await Promise.all(['vue', 'vue-router', 'vite'].map(async (name) =>
    [name, JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8')).version]
  )))
  const rows: CapabilityRow[] = []
  for (const externalPeers of [false, true]) {
    for (const profile of Object.keys(CAPABILITY_PROFILES) as CapabilityProfile[]) {
      let collected: Audit | undefined
      await build({
        root: options.fixtureRoot, configFile: false, mode: 'production', logLevel: 'error',
        define: productionClientDefines,
        resolve: {
          alias: [
            ...(options.mode === 'source' ? sourceClientAliases(options.frameworkRoot) : []),
            // The source/installed comparison uses exactly the same peer copies.
            ...(!externalPeers ? [
              { find: /^vue$/, replacement: require.resolve('vue/dist/vue.runtime.esm-bundler.js') },
              { find: /^vue-router$/, replacement: require.resolve('vue-router/dist/vue-router.mjs') },
            ] : []),
          ],
        },
        plugins: [ssrBundleAudit(options.frameworkRoot, (audit) => { collected = audit }, { moduleSources })],
        build: {
          write: false, minify: 'esbuild', cssCodeSplit: true,
          rollupOptions: {
            input: join(options.fixtureRoot, 'src', `${profile}.ts`),
            preserveEntrySignatures: 'strict',
            external: externalPeers ? ['vue', 'vue-router'] : [],
          },
        },
      })
      if (!collected || collected.entries.length !== 1) throw new Error(`${profile}: missing capability audit`)
      const audit = collected
      if (options.reportPath) await writeFile(options.reportPath, JSON.stringify({
        version: 1, dependencies, node: process.version, status: 'in-progress',
        reports: rows, current: { profile, externalPeers, chunks: audit.chunks, stylesheets: audit.stylesheets },
      }, null, 2))
      assertNoServerClientGraph(audit)
      assertBrowserActivationAccounting(audit)
      const facts = CAPABILITY_PROFILES[profile]
      const filesFor = (source: string) => audit.chunks.filter((chunk) => chunk.modules.some((module) =>
        module.renderedLength > 0 && module.sources.includes(source))).map((chunk) => chunk.file)
      // Awaited feature imports are critical bytes. Moving them behind import()
      // must not masquerade as savings for applications that actually need them.
      const activationSources = (Object.keys(BROWSER_ACTIVATION_SOURCES) as Array<keyof typeof BROWSER_ACTIVATION_SOURCES>)
        .filter((capability) => facts[capability])
        .map((capability) => BROWSER_ACTIVATION_SOURCES[capability])
      const activationFiles = activationSources.flatMap((source) => {
        const files = filesFor(source)
        if (!files.length) throw new Error(`${profile}: required activation module missing: ${source}`)
        return files
      })
      const routeFiles = audit.chunks.filter((chunk) => chunk.modules.some((module) =>
        module.renderedLength > 0 && /\/(?:Home|FetchPage|SeoPage|FullPage)\.ts$/.test(module.id)))
        .map((chunk) => chunk.file)
      const entryStatic = audit.critical([audit.entries[0]!.file])
      const bootstrap = audit.critical([...entryStatic.files, ...activationFiles])
      const route = audit.critical(routeFiles)
      const page = audit.critical([...bootstrap.files, ...routeFiles])
      assertCapabilityGraph(profile, audit, page)
      const laterFiles = audit.chunks.filter((chunk) => chunk.modules.some((module) => /\/Later\.ts$/.test(module.id))).map((chunk) => chunk.file)
      if (laterFiles.some((file) => page.files.includes(file))) throw new Error(`${profile}: sibling route entered the initial closure`)
      if (page.css.some((file) => /later/.test(file))) throw new Error(`${profile}: sibling CSS entered the initial closure`)
      if (facts.router && !routeFiles.length) throw new Error(`${profile}: lazy current route disappeared`)
      assertCapabilityPagePayload(page, externalPeers)
      const initial = (Object.keys(SSR_BROWSER_BOOTSTRAP_SOURCES) as SsrBrowserBootstrapCapability[])
        .filter((key) => facts[key === 'navigation' ? 'router' : key])
      const clientModuleId = audit.chunks.find((chunk) => chunk.file === audit.entries[0]!.file)!.facadeModuleId!
      const bootstrapManifest = audit.bootstrapManifest([{ id: 'app', clientModuleId, initial }])
      const mapped = bootstrapManifest.applications.app!.capabilities
      const bootstrapCapabilitySources = Object.fromEntries(Object.entries(mapped).map(([key, files]) => [key,
        [...new Set(audit.chunks.filter((chunk) => files.includes(chunk.file)).flatMap((chunk) => chunk.modules)
          .filter((module) => module.renderedLength > 0).flatMap((module) => module.sources))].sort(),
      ]))
      for (const key of initial) {
        const implementation = SSR_BROWSER_BOOTSTRAP_SOURCES[key]
        if (!retainedFrameworkSources(audit, entryStatic).includes(implementation) &&
            !bootstrapCapabilitySources[key]?.includes(implementation)) {
          throw new Error(profile + ': missing bootstrap mapping for ' + key)
        }
      }
      const criticalBootstrap = audit.bootstrapReport([audit.entries[0]!.file], activationFiles, routeFiles)
      if (JSON.stringify(criticalBootstrap.completeInitialPage.js) !== JSON.stringify(page.js)) {
        throw new Error(profile + ': Task 011 accounting changed complete initial JS')
      }
      rows.push({
        profile, externalPeers, mode: options.mode,
        activationSources, activationFiles, routeFiles,
        entryStatic, bootstrap, route, page,
        criticalBootstrap, bootstrapManifest, bootstrapCapabilitySources,
        frameworkSources: retainedFrameworkSources(audit, page),
        entryFrameworkSources: retainedFrameworkSources(audit, entryStatic),
        bootstrapFrameworkSources: retainedFrameworkSources(audit, bootstrap),
        chunks: audit.chunks, stylesheets: audit.stylesheets,
      })
    }
  }
  const reports = rows.map((row) => {
    const baseline = rows.find((candidate) => candidate.externalPeers === row.externalPeers &&
      candidate.profile === CAPABILITY_PROFILES[row.profile].baseline)!
    const delta = (value: typeof row.page.js, before: typeof row.page.js) => ({
      bytes: value.bytes - before.bytes, gzip: value.gzip - before.gzip, brotli: value.brotli - before.brotli,
    })
    return {
      ...row, baseline: baseline.profile,
      delta: {
        entry: delta(row.entryStatic.js, baseline.entryStatic.js),
        bootstrap: delta(row.bootstrap.js, baseline.bootstrap.js),
        page: delta(row.page.js, baseline.page.js),
        css: delta(row.page.cssSizes, baseline.page.cssSizes),
        resourceCount: row.page.resourceCount - baseline.page.resourceCount,
      },
    }
  })
  if (options.reportPath) await writeFile(options.reportPath, JSON.stringify({
    version: 1, dependencies, node: process.version,
    note: 'Whole-file bytes are exact for these outputs. Module ownership uses pre-minifier renderedLength. External-peer deltas still include fixture glue; no mixed-chunk compression is apportioned.',
    reports,
  }, null, 2))
  return reports
}

export const compareSsrCapabilityMatrices = (
  source: Awaited<ReturnType<typeof buildSsrCapabilityMatrix>>,
  installed: Awaited<ReturnType<typeof buildSsrCapabilityMatrix>>
) => installed.map((row) => {
  const control = source.find((candidate) => candidate.profile === row.profile && candidate.externalPeers === row.externalPeers)
  if (!control) throw new Error(`Missing source control for ${row.profile}`)
  for (const key of ['frameworkSources', 'entryFrameworkSources', 'bootstrapFrameworkSources'] as const) {
    assertInstalledCapabilityParity(control[key], row[key], `${row.profile}/${key}`)
  }
  if (JSON.stringify(control.bootstrapManifest.applications.app!.initial) !== JSON.stringify(row.bootstrapManifest.applications.app!.initial)) {
    throw new Error(row.profile + ': source/packed bootstrap application facts differ')
  }
  for (const capability of Object.keys(SSR_BROWSER_BOOTSTRAP_SOURCES)) {
    const sourceMapping = control.bootstrapCapabilitySources[capability] ?? []
    const packedMapping = row.bootstrapCapabilitySources[capability] ?? []
    assertInstalledCapabilityParity(sourceMapping, packedMapping, row.profile + '/bootstrap/' + capability)
    const boundaries = new Set<string>(Object.values(SSR_BROWSER_BOOTSTRAP_SOURCES))
    if (JSON.stringify(sourceMapping.filter((source) => boundaries.has(source))) !==
        JSON.stringify(packedMapping.filter((source) => boundaries.has(source)))) {
      throw new Error(row.profile + ': source/packed semantic capability mapping differs for ' + capability)
    }
  }
  return {
    profile: row.profile, externalPeers: row.externalPeers,
    bootstrapCapabilitySources: row.bootstrapCapabilitySources,
    source: control.page.js, installed: row.page.js,
    delta: Object.fromEntries((['bytes', 'gzip', 'brotli'] as const).map((key) => [key, row.page.js[key] - control.page.js[key]])),
  }
})

// Reused by the existing real packed-consumer report as well as the matrix.
export { inspectSsrBundle } from './SsrBundleAudit'
