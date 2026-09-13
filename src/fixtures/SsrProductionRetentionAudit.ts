import { createRequire } from 'node:module'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'
import type { ResolvedConfig } from 'vite'
import type { OutputBundle, OutputChunk, Plugin } from 'rollup'
import { readSsrRequestBootstrap, SSR_BROWSER_BOOTSTRAP_SOURCES } from '../SsrBrowserBootstrap'
import {
  parseSsrBootstrapAssetManifest,
  selectSsrBootstrapCapabilityFiles,
  selectSsrBootstrapCapabilityKeys,
  SSR_BROWSER_BOOTSTRAP_METADATA_PATH,
  type SsrBootstrapAssetManifest,
} from '../SsrBootstrapAssetRuntime'
import { resolveSsrViteEntries } from '../SsrConfigCompileRuntime'
import { renderSsrApplication } from '../SsrRenderRuntime'
import {
  createSsrRenderedAssetResolver,
  parseSsrViteManifest,
} from '../SsrRenderedAssetRuntime'
import { SSR_CLIENT_VIRTUAL_PREFIX, SSR_DEFAULT_APPLICATION_ID } from '../SsrRuntimeConfigCompile'
import { createTestRenderRequest } from '../SsrTestFixtures'
import { inspectSsrBundle, ssrBundleAudit, type BundleOwner } from './SsrBundleAudit'
import { buildSsrCapabilityMatrix, compareSsrCapabilityMatrices } from './SsrCapabilityMatrix'
import { inspectNuxtLandingProduction, renderNuxtComparisonMarkdown, TASK_011_NUXT_INITIAL_JS } from './SsrProductionNuxtComparison'
import {
  BROWSER_ACTIVATION_SOURCES,
  retainedFrameworkSources,
  type CapabilityProfile,
} from './SsrPerformanceContracts'

export type AuditOwner =
  | 'vue-ssr-lite'
  | 'Vue'
  | 'Vue Router'
  | 'application code'
  | 'third-party dependency'
  | 'unknown/unattributed'

export type FrameworkRetentionClass =
  | 'REQUIRED_CORE'
  | 'CONDITIONAL'
  | 'DEFERABLE'
  | 'SUSPICIOUS_OR_ACCIDENTAL'

type Audit = ReturnType<typeof inspectSsrBundle>
type Chunk = Audit['chunks'][number]
type ModuleRecord = Chunk['modules'][number]
type Sizes = { bytes: number; gzip: number; brotli: number }

const normalize = (id: string) => id.replaceAll('\\', '/').split('?', 1)[0]!
const filesystemId = (id: string) => normalize(id).replace(/^\0+/, '')
const kb = (bytes: number) => `${(bytes / 1000).toFixed(1)} KB`
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)
const RESOLVED_CLIENT_PREFIX = `\0${SSR_CLIENT_VIRTUAL_PREFIX}`
const DYNAMIC_BOUNDARIES = new Set<string>(Object.values(SSR_BROWSER_BOOTSTRAP_SOURCES))
const COMPARISON_PROFILES = ['minimal', 'router', 'seo', 'full'] as const satisfies readonly CapabilityProfile[]

/** Task 011 production browser/network observation of Playground/nuxt-vue-ssr. Not a fixture raw size. */
export const TASK_011_PRODUCTION_NETWORK_TRACE = {
  source: 'Task 011 production browser/network trace (nuxt-vue-ssr/landing)',
  appJs: {
    metric: 'transferred' as const,
    bytes: 118_771,
    contentEncoding: 'br' as const,
    note: 'Network transfer of the vue-ssr-lite landing app.js with Content-Encoding: br. Not a raw, gzip, or fixture size. Not the Builto landing app.',
  },
  completeInitialJs: {
    metric: 'transferred' as const,
    bytes: 163_900,
    approximate: true,
    note: 'Complete initial JS transferred for the vue-ssr-lite landing in the same network-trace family as 118,771 B. Approximate 163.9 KB.',
  },
  nuxtInitialJs: TASK_011_NUXT_INITIAL_JS,
} as const

export const compareLikeForLike = (
  left: { metric: string; bytes: number },
  right: { metric: string; bytes: number },
) => ({
  comparable: left.metric === right.metric,
  left: left.bytes,
  right: right.bytes,
  deltaBytes: left.metric === right.metric ? right.bytes - left.bytes : null,
})

export const compressionProfiles = (source: string | Uint8Array) => {
  const raw = typeof source === 'string' ? Buffer.byteLength(source) : source.byteLength
  return {
    raw: { metric: 'raw' as const, bytes: raw, encoder: 'uncompressed-file-bytes' },
    gzipNodeDefault: {
      metric: 'gzip' as const,
      bytes: gzipSync(source).byteLength,
      encoder: 'node-zlib-gzip-default',
    },
    brotliNodeQuality11: {
      metric: 'brotli' as const,
      bytes: brotliCompressSync(source).byteLength,
      encoder: 'node-zlib-brotli-quality-11',
    },
    brotliNodeQuality5: {
      metric: 'brotli' as const,
      bytes: brotliCompressSync(source, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }).byteLength,
      encoder: 'node-zlib-brotli-quality-5',
    },
  }
}

const OWNER_LABEL: Record<BundleOwner, AuditOwner> = {
  vue: 'Vue',
  'vue-router': 'Vue Router',
  'framework-core': 'vue-ssr-lite',
  'framework-fetch': 'vue-ssr-lite',
  'framework-seo': 'vue-ssr-lite',
  'framework-middleware': 'vue-ssr-lite',
  'framework-navigation': 'vue-ssr-lite',
  'framework-extensions': 'vue-ssr-lite',
  'framework-reactivity': 'vue-ssr-lite',
  application: 'application code',
  'third-party': 'third-party dependency',
  bundler: 'unknown/unattributed',
}

export const auditOwner = (owner: BundleOwner): AuditOwner => OWNER_LABEL[owner] ?? 'unknown/unattributed'

const emptyOwnership = (): Record<AuditOwner, number> => ({
  'vue-ssr-lite': 0, Vue: 0, 'Vue Router': 0, 'application code': 0,
  'third-party dependency': 0, 'unknown/unattributed': 0,
})

const addOwnership = (target: Record<AuditOwner, number>, owner: AuditOwner, amount: number) => {
  target[owner] += amount
}

const packageName = (id: string): string | undefined => {
  const path = filesystemId(id)
  const index = path.lastIndexOf('/node_modules/')
  if (index < 0) return undefined
  const rest = path.slice(index + '/node_modules/'.length)
  if (!rest || rest.startsWith('.')) return undefined
  return rest.startsWith('@') ? rest.split('/').slice(0, 2).join('/') : rest.split('/')[0]
}

const packageRoot = (id: string): string | undefined => {
  const name = packageName(id)
  if (!name) return undefined
  const path = filesystemId(id)
  const marker = `/node_modules/${name}`
  const index = path.lastIndexOf(marker)
  return index >= 0 ? path.slice(0, index + marker.length) : undefined
}

const shortModule = (id: string, frameworkRoot?: string): string => {
  const path = normalize(id)
  if (frameworkRoot) {
    const root = normalize(frameworkRoot).replace(/\/$/, '')
    if (path.startsWith(`${root}/src/`)) return path.slice(`${root}/src/`.length)
  }
  const distribution = path.split('/node_modules/vue-ssr-lite/dist/')[1]
  if (distribution) return `vue-ssr-lite/dist/${distribution}`
  const pkg = packageName(path)
  if (pkg) {
    const root = packageRoot(path)
    return root && path.startsWith(`${root}/`) ? `${pkg}:${path.slice(root.length + 1)}` : pkg
  }
  if (path.includes('virtual:vue-ssr-lite/client') || path.includes(SSR_CLIENT_VIRTUAL_PREFIX)) return 'client entry'
  if (path.endsWith('index.html')) return 'client entry HTML'
  if (path.startsWith('\0')) return path.replace(/^\0+/, 'virtual:')
  return path.split('/').slice(-3).join('/')
}

const collectStaticPaths = (audit: Audit, entryFiles: readonly string[], known: readonly { moduleId: string; path: string[] }[] = []) => {
  const byFile = new Map(audit.chunks.map((chunk) => [chunk.file, chunk]))
  const byId = new Map(audit.chunks.flatMap((chunk) => chunk.modules.map((module) => [module.id, module] as const)))
  const canonical = new Map<string, string>()
  for (const id of byId.keys()) {
    if (!canonical.has(normalize(id))) canonical.set(normalize(id), id)
  }
  const resolveId = (id: string) => byId.has(id) ? id : canonical.get(normalize(id)) ?? id
  const paths = new Map<string, string[]>()
  const queue: string[] = []
  const remember = (id: string, path: string[]) => {
    paths.set(id, path)
    paths.set(normalize(id), path)
  }
  const seed = (id: string | null | undefined, prefix: readonly string[] = []) => {
    if (!id) return
    const resolved = resolveId(id)
    if (paths.has(resolved)) return
    remember(resolved, [...prefix, resolved])
    queue.push(resolved)
  }
  for (const file of entryFiles) {
    const chunk = byFile.get(file)
    if (!chunk) continue
    seed(chunk.facadeModuleId)
    for (const module of chunk.modules) {
      if (module.id.includes(SSR_CLIENT_VIRTUAL_PREFIX) || module.id.includes('virtual:vue-ssr-lite/client')) {
        seed(module.id, chunk.facadeModuleId ? [chunk.facadeModuleId] : [])
      }
    }
  }
  for (const item of known) if (item.path.length) seed(item.moduleId, item.path.slice(0, -1))
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!
    for (const dependency of byId.get(id)?.imports ?? []) {
      const resolved = resolveId(dependency)
      if (paths.has(resolved)) continue
      remember(resolved, [...(paths.get(id) ?? [id]), resolved])
      queue.push(resolved)
    }
  }
  return {
    get: (id: string) => paths.get(id) ?? paths.get(normalize(id)),
    has: (id: string) => paths.has(id) || paths.has(normalize(id)),
  }
}

const ownershipOf = (modules: readonly ModuleRecord[]): Record<AuditOwner, number> => {
  const ownership = emptyOwnership()
  for (const module of modules) addOwnership(ownership, auditOwner(module.owner), module.renderedLength)
  return ownership
}

const thirdPartyBreakdown = (modules: readonly ModuleRecord[]) => {
  const totals = new Map<string, number>()
  for (const module of modules) {
    if (module.renderedLength <= 0 || auditOwner(module.owner) !== 'third-party dependency') continue
    const name = packageName(module.id) ?? 'unscoped-third-party'
    totals.set(name, (totals.get(name) ?? 0) + module.renderedLength)
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([name, renderedLength]) => ({ name, renderedLength }))
}

export const detectDuplicatePackages = (modules: readonly ModuleRecord[]) => {
  const packages = new Map<string, { roots: Set<string>; renderedLength: number }>()
  const framework = new Map<string, Set<string>>()
  for (const module of modules) {
    if (!module.renderedLength) continue
    const name = packageName(module.id)
    const root = packageRoot(module.id)
    if (name && root) {
      const current = packages.get(name) ?? { roots: new Set<string>(), renderedLength: 0 }
      current.roots.add(root)
      current.renderedLength += module.renderedLength
      packages.set(name, current)
    }
    for (const source of module.sources) {
      const identities = framework.get(source) ?? new Set()
      identities.add(normalize(module.id))
      framework.set(source, identities)
    }
  }
  const rows = [...packages.entries()].map(([name, info]) => ({
    name,
    renderedLength: info.renderedLength,
    roots: [...info.roots].sort(),
  })).sort((a, b) => b.renderedLength - a.renderedLength || (a.name < b.name ? -1 : 1))
  return {
    packages: rows.filter((row) => row.roots.length > 1),
    inspectedPackages: rows,
    frameworkSources: [...framework.entries()].filter(([, ids]) => ids.size > 1)
      .map(([source, ids]) => ({ source, moduleIds: [...ids].sort() })),
  }
}

const classifyFrameworkSource = (
  source: string,
  options: { entryStatic: boolean; capability: boolean; appUses: Record<'router' | 'seo' | 'middleware' | 'fetch' | 'extensions' | 'reactivity', boolean> }
): { classification: FrameworkRetentionClass; reason: string } => {
  const { entryStatic, capability, appUses } = options
  if (/SeoEndpoints|SsrSitemap|SsrSiteOrigin|SsrServer|SsrObservability|SsrApplicationRuntime/.test(source) ||
      source.startsWith('server/') || source.startsWith('cli/') || source.startsWith('deployment/')) {
    return { classification: 'SUSPICIOUS_OR_ACCIDENTAL', reason: 'Server/build implementation is retained in the browser graph.' }
  }
  if (source.startsWith('server-routes/')) {
    return { classification: 'SUSPICIOUS_OR_ACCIDENTAL', reason: 'Public server-route helpers are not required to hydrate.' }
  }
  if (DYNAMIC_BOUNDARIES.has(source) || source === 'middleware/SsrMiddlewareExecution.ts') {
    if (entryStatic) return { classification: 'SUSPICIOUS_OR_ACCIDENTAL', reason: 'Task 011 already treats this as a dynamic capability boundary.' }
    return { classification: 'CONDITIONAL', reason: 'Correctly retained only in an activated capability chunk.' }
  }
  if (source.startsWith('data/fetch/') && source !== 'data/fetch/runtime/SsrFetchRuntimeScope.ts') {
    if (!appUses.fetch) return { classification: 'SUSPICIOUS_OR_ACCIDENTAL', reason: 'Fetch execution is retained although the consumer does not use useFetch/setContext.' }
    return entryStatic
      ? { classification: 'DEFERABLE', reason: 'Fetch execution is application-used but is not part of hydration bootstrap.' }
      : { classification: 'CONDITIONAL', reason: 'Fetch execution is outside the entry-static closure.' }
  }
  if (source === 'SsrReactivityRuntime.ts') {
    if (!appUses.reactivity) {
      return entryStatic
        ? { classification: 'SUSPICIOUS_OR_ACCIDENTAL', reason: 'ssrWatch is unused by this consumer but still statically retained.' }
        : { classification: 'CONDITIONAL', reason: 'Watcher bridge is present only because a later graph imported it.' }
    }
    return { classification: 'CONDITIONAL', reason: 'Public watcher bridge is required by this consumer.' }
  }
  if (source === 'navigation/LoadingIndicator.ts') {
    return entryStatic
      ? { classification: 'DEFERABLE', reason: 'Loading UI is not required to hydrate the first SSR document.' }
      : { classification: 'CONDITIONAL', reason: 'Loading UI stays with navigation, not the entry.' }
  }
  if (source === 'navigation/RouterView.ts' || source === 'navigation/index.ts' || source === 'navigation/SsrNavigationContext.ts') {
    return { classification: 'REQUIRED_CORE', reason: 'Router-enabled hydration needs the outlet/context before the navigation runtime chunk.' }
  }
  if (source.startsWith('extensions/seo/') || source === 'extensions/seo/index.ts') {
    if (source === 'extensions/seo/useSeo.ts' || source === 'extensions/seo/state.ts' || source === 'extensions/seo/types.ts' ||
        source === 'extensions/seo/normalize.ts' || source === 'extensions/seo/client.ts') {
      return appUses.seo
        ? { classification: 'CONDITIONAL', reason: 'Landing pages call useSeo during the first hydrated tree.' }
        : { classification: 'SUSPICIOUS_OR_ACCIDENTAL', reason: 'SEO helpers are retained without a consumer useSeo/site config.' }
    }
    return capability
      ? { classification: 'CONDITIONAL', reason: 'SEO lifecycle belongs to the capability chunk.' }
      : { classification: 'DEFERABLE', reason: 'SEO work already has a dynamic capability boundary.' }
  }
  if (source.startsWith('middleware/') && source !== 'middleware/SsrBrowserMiddleware.ts' && source !== 'middleware/SsrMiddlewarePresence.ts') {
    return appUses.middleware
      ? { classification: entryStatic ? 'DEFERABLE' : 'CONDITIONAL', reason: 'Route middleware exists, but the executor already loads through SsrBrowserMiddleware.' }
      : { classification: 'SUSPICIOUS_OR_ACCIDENTAL', reason: 'Middleware implementation is retained without consumer middleware.' }
  }
  if (source.startsWith('core/extensions/') && source !== 'core/extensions/ExtensionRuntimeKey.ts') {
    return appUses.extensions || appUses.seo
      ? { classification: capability ? 'CONDITIONAL' : 'DEFERABLE', reason: 'Extension runtime already has a Task 011 dynamic boundary.' }
      : { classification: 'SUSPICIOUS_OR_ACCIDENTAL', reason: 'Extension runtime is retained without consumer extensions/SEO.' }
  }
  if (source === 'index.ts') {
    return { classification: 'CONDITIONAL', reason: 'Public package barrel; only its used runtime exports should survive tree-shaking.' }
  }
  if (source === 'client.ts') {
    return { classification: 'REQUIRED_CORE', reason: 'Generated browser entry imports hydrate/mount from vue-ssr-lite/client.' }
  }
  return { classification: 'REQUIRED_CORE', reason: 'Hydration host, request context, or application core needed before mount.' }
}

const modulesIn = (audit: Audit, files: readonly string[]) =>
  audit.chunks.filter((chunk) => files.includes(chunk.file)).flatMap((chunk) => chunk.modules)

const roleForChunk = (
  file: string,
  report: ReturnType<Audit['bootstrapReport']>
): 'entry-static JS' | 'initial capability JS' | 'route/application JS' | 'later/deferred JS' => {
  if (report.entryStatic.files.includes(file)) return 'entry-static JS'
  if (report.initialCapabilities.files.includes(file)) return 'initial capability JS'
  if (report.renderedRoute.files.includes(file)) return 'route/application JS'
  return 'later/deferred JS'
}

const describeConsumer = (audit: Audit, frameworkRoot: string) => {
  const application = modulesIn(audit, audit.chunks.map((chunk) => chunk.file))
    .filter((module) => module.renderedLength > 0 && module.owner === 'application')
    .map((module) => normalize(module.id))
  const imported = [...new Set(modulesIn(audit, audit.chunks.map((chunk) => chunk.file)).flatMap((module) => module.imports.map(normalize)))]
  return {
    router: application.some((id) => /\/(?:routes|router)\.[cm]?[jt]sx?$/.test(id)) || retainedFrameworkSources(audit).includes('navigation/RouterView.ts'),
    seo: application.some((id) => /useSeo|PublicPageSeo|createHomeSeo/.test(id)) || imported.some((id) => id.endsWith('/extensions/seo/useSeo.ts')),
    middleware: application.some((id) => /middleware/i.test(id)),
    fetch: imported.some((id) => /\/useFetch\.ts$|\/setContext\.ts$/.test(id)),
    extensions: retainedFrameworkSources(audit).includes('core/extensions/ExtensionRuntime.ts'),
    reactivity: imported.some((id) => id.endsWith('/SsrReactivityRuntime.ts')),
    frameworkRoot,
  }
}

const ADDITIVE_AUDIT_PLUGINS = ['vue-ssr-lite:task-012-observe', 'vue-ssr-lite:test-bundle-audit'] as const
/** vue-apollo-client runs GraphQL codegen in Vite `serve` only. The production client build does not. */
export const LANDING_SERVE_ONLY_CODEGEN_PLUGIN = 'vue-apollo-dts'

export type LandingRenderLoader = {
  kind: 'vue-tailwind-observed-aliases'
  omittedPlugins: readonly string[]
  reason: string
}

export type LandingCliDeployment = {
  target: string
  plugins: readonly string[]
  moduleGraphEffect: 'none'
  note: string
}

export type LandingRequestEvidence =
  | {
      kind: 'authoritative-render'
      path: string
      capabilities: ReturnType<typeof readSsrRequestBootstrap>
      renderedModules: readonly string[]
      loadedModuleIds: readonly string[]
      htmlBytes: number
    }
  | {
      kind: 'unavailable'
      path: string
      error: string
    }

type ViteModuleLike = {
  id?: string | null
  file?: string | null
  url?: string
  ssrModule?: unknown
  transformResult?: unknown
  ssrTransformResult?: unknown
}

type ViteModuleGraphLike = {
  idToModuleMap?: Map<string, ViteModuleLike>
  urlToModuleMap?: Map<string, ViteModuleLike>
}

type ViteRenderHost = {
  ssrLoadModule: (id: string) => Promise<Record<string, unknown>>
  moduleGraph?: ViteModuleGraphLike
  environments?: Record<string, { moduleGraph?: ViteModuleGraphLike }>
}

const viteModuleWasEvaluated = (mod: ViteModuleLike) =>
  mod.ssrModule != null || mod.transformResult != null || mod.ssrTransformResult != null

/** Module ids Vite actually evaluated while serving the authoritative landing render. */
export const collectEvaluatedViteModuleIds = (vite: ViteRenderHost) => {
  const ids: string[] = []
  const seen = new Set<string>()
  const consider = (mod?: ViteModuleLike) => {
    if (!mod || !viteModuleWasEvaluated(mod)) return
    for (const id of [mod.id, mod.file, mod.url]) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
  }
  const walk = (graph?: ViteModuleGraphLike) => {
    graph?.idToModuleMap?.forEach(consider)
    graph?.urlToModuleMap?.forEach(consider)
  }
  walk(vite.moduleGraph)
  for (const environment of Object.values(vite.environments ?? {})) walk(environment.moduleGraph)
  return ids
}

const hrefFile = (href: string, base: string) => {
  if (base !== '/' && href.startsWith(base)) return href.slice(base.length).replace(/^\//, '')
  return href.replace(/^\//, '')
}

export const routeAssetsFromRenderedModules = (
  moduleIds: readonly string[],
  manifest: ReturnType<typeof parseSsrViteManifest>,
  options: { applicationId: string; base: string; root: string },
) => {
  const resolve = createSsrRenderedAssetResolver(manifest, options.base, options.root)
  const files: string[] = []
  const css: string[] = []
  const unmatched: string[] = []
  for (const id of moduleIds) {
    try {
      for (const asset of resolve(options.applicationId, [id])) {
        const file = hrefFile(asset.href, options.base)
        if (asset.rel === 'modulepreload') files.push(file)
        else css.push(file)
      }
    } catch {
      unmatched.push(id)
    }
  }
  return {
    files: [...new Set(files)],
    css: [...new Set(css)],
    unmatched,
  }
}

export type CompleteInitialClaim = 'exact' | 'not-claimed'

export type CompleteInitialManifestEvidence =
  | {
      kind: 'resolved'
      files: readonly string[]
      css: readonly string[]
      unmatched: readonly string[]
    }
  | {
      kind: 'unavailable'
      error: string
      unmatched: readonly string[]
    }

export const isCompleteInitialExternalResource = (file: string) =>
  /^https?:\/\//i.test(file) || file.startsWith('//')

export const normalizeAuditModuleId = (id: string, root?: string) => {
  const path = filesystemId(id)
  if (!root) return path
  const base = normalize(root).replace(/\/$/, '')
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
}

export const moduleProvenEntryStatic = (
  moduleId: string,
  entryStaticModuleIds: readonly string[],
  root?: string,
) => {
  const target = normalizeAuditModuleId(moduleId, root)
  return entryStaticModuleIds.some((id) => normalizeAuditModuleId(id, root) === target)
}

export const decideCompleteInitialClaim = (input: {
  requestKind: 'authoritative-render' | 'unavailable'
  manifest: CompleteInitialManifestEvidence
  entryStaticModuleIds: readonly string[]
  emittedFiles: readonly string[]
  selectedCapabilityFiles: readonly string[]
  selectedRouteFiles?: readonly string[]
  selectedRouteCss?: readonly string[]
  root?: string
}) => {
  const reasons: string[] = []
  const routeFiles = input.selectedRouteFiles ?? (input.manifest.kind === 'resolved' ? input.manifest.files : [])
  const routeCss = input.selectedRouteCss ?? (input.manifest.kind === 'resolved' ? input.manifest.css : [])
  if (input.requestKind !== 'authoritative-render') {
    reasons.push('The `/` request bootstrap was not obtained from an authoritative landing render.')
    return { claim: 'not-claimed' as const satisfies CompleteInitialClaim, reasons, provenEntryStatic: [], unresolvedModules: [] }
  }
  if (input.manifest.kind !== 'resolved') {
    reasons.push(`The production SSR manifest was not successfully read and parsed: ${input.manifest.error}`)
    return {
      claim: 'not-claimed' as const satisfies CompleteInitialClaim,
      reasons,
      provenEntryStatic: [],
      unresolvedModules: [...input.manifest.unmatched],
    }
  }
  const provenEntryStatic = input.manifest.unmatched.filter((id) =>
    moduleProvenEntryStatic(id, input.entryStaticModuleIds, input.root))
  const unresolvedModules = input.manifest.unmatched.filter((id) =>
    !moduleProvenEntryStatic(id, input.entryStaticModuleIds, input.root))
  if (unresolvedModules.length) {
    reasons.push(`Rendered modules were not reconciled to the production SSR manifest and are not proven entry-static: ${unresolvedModules.join(', ')}`)
  }
  const selectedJs = [...input.selectedCapabilityFiles, ...routeFiles]
  const missingJs = selectedJs.filter((file) => !input.emittedFiles.includes(file))
  if (missingJs.length) {
    reasons.push(`Selected capability/route JS is missing from the observed bundle: ${missingJs.join(', ')}`)
  }
  const accounting = [...selectedJs, ...routeCss]
  const external = accounting.filter((file) => isCompleteInitialExternalResource(file))
  if (external.length) {
    reasons.push(`Complete-initial accounting includes unresolved/external JS or CSS: ${external.join(', ')}`)
  }
  const missingCss = routeCss.filter((file) => !isCompleteInitialExternalResource(file) && !input.emittedFiles.includes(file))
  if (missingCss.length) {
    reasons.push(`Complete-initial CSS is missing from the observed bundle: ${missingCss.join(', ')}`)
  }
  return {
    claim: (reasons.length ? 'not-claimed' : 'exact') as CompleteInitialClaim,
    reasons,
    provenEntryStatic,
    unresolvedModules,
  }
}

const renderLandingPath = async (
  vite: ViteRenderHost,
  options: {
    path: string
    applicationId: string
    seo?: Parameters<typeof renderSsrApplication>[0]['seo']
    middleware?: Parameters<typeof renderSsrApplication>[0]['middleware']
  },
): Promise<Extract<LandingRequestEvidence, { kind: 'authoritative-render' }>> => {
  const [main, root] = await Promise.all([
    vite.ssrLoadModule('/src/main.ts'),
    vite.ssrLoadModule('/src/App.vue'),
  ])
  if (!root?.default) throw new Error('Landing App.vue has no default export.')
  if (!main?.routes) throw new Error('Landing main.ts does not export the application routes.')
  const rendered = await renderSsrApplication({
    id: options.applicationId,
    root: root.default as Parameters<typeof renderSsrApplication>[0]['root'],
    routes: main.routes as Parameters<typeof renderSsrApplication>[0]['routes'],
    install: main.default as Parameters<typeof renderSsrApplication>[0]['install'],
    seo: options.seo,
    middleware: options.middleware,
  }, createTestRenderRequest('drixal.test', {
    url: `https://drixal.test${options.path}`,
    siteOrigin: process.env.BASE_DOMAIN ? `https://${process.env.BASE_DOMAIN}` : 'https://drixal.com',
    publicConfig: {
      appName: process.env.APP_NAME || 'Drixal',
      base_domain: process.env.BASE_DOMAIN || 'drixal.com',
    },
  }))
  return {
    kind: 'authoritative-render',
    path: options.path,
    capabilities: readSsrRequestBootstrap(rendered),
    renderedModules: [...rendered.renderedModules],
    loadedModuleIds: collectEvaluatedViteModuleIds(vite),
    htmlBytes: Buffer.byteLength(rendered.html),
  }
}

export const omitLandingServeOnlyCodegen = <T extends { name?: string }>(plugins: readonly T[]) =>
  plugins.filter((plugin) => plugin.name !== LANDING_SERVE_ONLY_CODEGEN_PLUGIN)

const snapshotLandingCliDeployment = async (landingRoot: string): Promise<LandingCliDeployment> => {
  const environmentUrl = pathToFileURL(join(landingRoot, 'node_modules/vue-ssr-lite/dist/deployment/DeploymentEnvironment.mjs')).href
  const runtimeUrl = pathToFileURL(join(landingRoot, 'node_modules/vue-ssr-lite/dist/deployment/DeploymentRuntime.mjs')).href
  const { resolveDeploymentEnvironment } = await import(environmentUrl) as {
    resolveDeploymentEnvironment: (environment?: NodeJS.ProcessEnv) => string
  }
  const { createDeploymentBuild } = await import(runtimeUrl) as {
    createDeploymentBuild: (root: string) => { plugins: Array<{ name: string }> }
  }
  const target = resolveDeploymentEnvironment(process.env)
  const plugins = createDeploymentBuild(landingRoot).plugins.map((plugin) => plugin.name)
  return {
    target,
    plugins,
    moduleGraphEffect: 'none',
    note: target === 'node'
      ? 'Installed `vue-ssr-lite build` spreads createDeploymentBuild(root).plugins into the client Vite build. For target node that array is empty, so omitting it does not change the production plugin graph.'
      : 'Installed `vue-ssr-lite build` adds vue-ssr-lite:deployment-output, which only records outDir in configResolved. It does not transform modules. This audit still does not add it; only observe/audit plugins are additive.',
  }
}

const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const flattenLandingVitePlugins = async (plugins: unknown): Promise<Array<{ name?: string }>> => {
  const items = Array.isArray(plugins) ? plugins : plugins == null ? [] : [plugins]
  const out: Array<{ name?: string }> = []
  for (const item of items) {
    const resolved = await item
    if (resolved == null || resolved === false) continue
    if (Array.isArray(resolved)) {
      out.push(...await flattenLandingVitePlugins(resolved))
      continue
    }
    out.push(resolved as { name?: string })
  }
  return out
}

const isVueSsrLitePlugin = (name: string | undefined) =>
  name === 'vue-ssr-lite' || (name?.startsWith('vue-ssr-lite:') ?? false)

const createLandingSourceServer = async (options: {
  landingRoot: string
  aliases?: readonly { find: string; replacement: string }[]
}) => {
  const landingRequire = createRequire(join(options.landingRoot, 'package.json'))
  const viteNs = await import(pathToFileURL(landingRequire.resolve('vite')).href) as typeof import('vite')
  const vue = ((await import(pathToFileURL(landingRequire.resolve('@vitejs/plugin-vue')).href)) as { default: () => unknown }).default
  const tailwindcss = ((await import(pathToFileURL(landingRequire.resolve('@tailwindcss/vite')).href)) as { default: () => unknown }).default
  const loaded = await viteNs.loadConfigFromFile(
    { command: 'serve', mode: 'production' },
    join(options.landingRoot, 'vite.config.ts'),
    options.landingRoot,
  )
  const consumerPlugins = await flattenLandingVitePlugins(loaded?.config.plugins)
  const omittedPlugins = consumerPlugins.filter((plugin) => isVueSsrLitePlugin(plugin.name)).map((plugin) => plugin.name!)
  const plugins = consumerPlugins.filter((plugin) => !isVueSsrLitePlugin(plugin.name))
  return {
    vite: await viteNs.createServer({
      configFile: false,
      root: options.landingRoot,
      mode: 'production',
      plugins: (plugins.length ? plugins : [vue(), tailwindcss()]) as never,
      resolve: {
        alias: (options.aliases ?? [])
          .filter((alias) => !alias.find.startsWith('/'))
          .map((alias) => ({ find: alias.find, replacement: alias.replacement })),
      },
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, hmr: false, watch: null },
      appType: 'custom',
    }),
    loader: {
      kind: 'vue-tailwind-observed-aliases' as const,
      omittedPlugins: omittedPlugins.length ? omittedPlugins : ['vue-ssr-lite'],
      reason: 'This server only transforms landing source for ssrLoadModule. It does not rebuild the production client graph. Consumer Vite plugins from landing `vite.config.ts` are kept (including application auto-imports). Installed vue-ssr-lite is omitted because its Vite serve plugin stalled createServer in this audit.',
    },
  }
}

export const renderLandingRequests = async (options: {
  landingRoot: string
  applicationId: string
  seo?: Parameters<typeof renderSsrApplication>[0]['seo']
  middleware?: Parameters<typeof renderSsrApplication>[0]['middleware']
  aliases?: readonly { find: string; replacement: string }[]
}) => {
  const previousCwd = process.cwd()
  process.chdir(options.landingRoot)
  const { vite, loader } = await withTimeout(createLandingSourceServer(options), 20_000, 'landing source server')
  try {
    let slash: LandingRequestEvidence
    try {
      slash = await withTimeout(renderLandingPath(vite, { ...options, path: '/' }), 20_000, 'landing / render')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        slash: { kind: 'unavailable', path: '/', error: message },
        contrast: { kind: 'unavailable', path: '/solutions', error: message },
        loader,
      }
    }
    let contrast: LandingRequestEvidence
    try {
      contrast = await withTimeout(
        renderLandingPath(vite, { ...options, path: '/solutions' }),
        10_000,
        'landing /solutions render',
      )
    } catch (error) {
      contrast = {
        kind: 'unavailable',
        path: '/solutions',
        error: error instanceof Error ? error.message : String(error),
      }
    }
    return { slash, contrast, loader }
  } finally {
    await vite.close()
    process.chdir(previousCwd)
  }
}

export const analyzeProductionBundle = (
  audit: Audit,
  options: {
    label: string
    frameworkRoot: string
    entryFiles?: readonly string[]
    capabilityFiles?: readonly string[]
    routeFiles?: readonly string[]
    routeCss?: readonly string[]
  }
) => {
  const entryFiles = options.entryFiles ?? audit.entries.map((entry) => entry.file)
  if (!entryFiles.length) throw new Error(`${options.label}: missing client entry`)
  const entryChunk = audit.chunks.find((chunk) => entryFiles.includes(chunk.file) && chunk.entry) ??
    audit.chunks.find((chunk) => entryFiles.includes(chunk.file))
  const clientModuleId = entryChunk?.facadeModuleId ?? `${RESOLVED_CLIENT_PREFIX}${SSR_DEFAULT_APPLICATION_ID}`
  const appUses = describeConsumer(audit, options.frameworkRoot)
  const activationFiles = options.capabilityFiles ?? (Object.keys(BROWSER_ACTIVATION_SOURCES) as Array<keyof typeof BROWSER_ACTIVATION_SOURCES>)
    .filter((capability) => appUses[capability === 'router' ? 'router' : capability])
    .flatMap((capability) => audit.chunks.filter((chunk) => chunk.modules.some((module) =>
      module.renderedLength > 0 && module.sources.includes(BROWSER_ACTIVATION_SOURCES[capability]))).map((chunk) => chunk.file))
  const routeFiles = options.routeFiles !== undefined
    ? options.routeFiles
    : audit.chunks.filter((chunk) => chunk.modules.some((module) =>
      module.renderedLength > 0 && module.owner === 'application' &&
      /\/(?:Home|HomePage|App|PublicLayout|NotFound)\.[jt]sx?$|\/(?:Home|HomePage|App|PublicLayout|NotFound)\.vue$/.test(normalize(module.id))))
      .map((chunk) => chunk.file)
  const bootstrap = audit.bootstrapReport(entryFiles, activationFiles, routeFiles, options.routeCss)
  const paths = collectStaticPaths(audit, entryFiles, bootstrap.staticRetention)
  const manifest = audit.bootstrapManifest([{
    id: SSR_DEFAULT_APPLICATION_ID,
    clientModuleId,
    initial: (Object.keys(SSR_BROWSER_BOOTSTRAP_SOURCES) as Array<keyof typeof SSR_BROWSER_BOOTSTRAP_SOURCES>)
      .filter((key) => key === 'navigation' ? appUses.router : key === 'seo' ? appUses.seo : key === 'middleware' ? appUses.middleware : appUses.extensions),
  }])
  const entryModules = modulesIn(audit, bootstrap.entryStatic.files).filter((module) => module.renderedLength > 0)
  const appJs = entryChunk ?? audit.chunks.find((chunk) => /(?:^|\/)app-[^/]+\.js$/.test(chunk.file)) ?? entryChunk
  const appModules = appJs ? appJs.modules.filter((module) => module.renderedLength > 0) : []
  const fileFor = (id: string) => audit.chunks.find((chunk) => chunk.modules.some((item) => item.id === id))?.file ?? ''
  const frameworkEntry = entryModules.filter((module) => module.owner.startsWith('framework-'))
    .flatMap((module) => {
      const file = fileFor(module.id)
      return module.sources.map((source) => ({
        source, file, moduleId: module.id, renderedLength: module.renderedLength, renderedExports: module.renderedExports,
        path: (paths.get(module.id) ?? []).map((id) => shortModule(id, options.frameworkRoot)),
        retention: paths.has(module.id) ? 'static-import-path' : 'emitted-static-chunk',
        ...classifyFrameworkSource(source, {
          entryStatic: bootstrap.entryStatic.files.includes(file),
          capability: bootstrap.initialCapabilities.files.includes(file),
          appUses,
        }),
      }))
    })
    .sort((a, b) => b.renderedLength - a.renderedLength || (a.source < b.source ? -1 : 1))
  const uniqueFramework = new Map<string, (typeof frameworkEntry)[number]>()
  for (const item of frameworkEntry) {
    const previous = uniqueFramework.get(item.source)
    if (!previous || item.renderedLength > previous.renderedLength) uniqueFramework.set(item.source, item)
  }
  const chunkRows = audit.chunks.map((chunk) => ({
    file: chunk.file,
    ...chunk.sizes,
    role: roleForChunk(chunk.file, bootstrap),
    owner: auditOwner(dominantOwner(chunk.modules)),
    renderedLengthByOwner: ownershipOf(chunk.modules),
    entry: chunk.entry,
  })).sort((a, b) => b.bytes - a.bytes)
  const describeRetained = (modules: readonly ModuleRecord[]) =>
    [...modules].filter((module) => module.renderedLength > 0)
      .sort((a, b) => b.renderedLength - a.renderedLength || (a.id < b.id ? -1 : 1))
      .map((module) => ({
        id: shortModule(module.id, options.frameworkRoot),
        moduleId: module.id,
        owner: auditOwner(module.owner),
        package: packageName(module.id),
        renderedLength: module.renderedLength,
        originalLength: module.originalLength,
        renderedExports: module.renderedExports,
        path: (paths.get(module.id) ?? []).map((id) => shortModule(id, options.frameworkRoot)),
        retention: paths.has(module.id) ? 'static-import-path' : 'emitted-static-chunk',
        sources: module.sources,
        file: fileFor(module.id),
      }))
  const allModules = audit.chunks.flatMap((chunk) => chunk.modules)
  const initialModules = modulesIn(audit, bootstrap.completeInitialPage.files)
  const topModules = describeRetained(appModules)
  const completeInitialModules = describeRetained(initialModules)
  return {
    label: options.label,
    appFile: appJs?.file ?? entryFiles[0]!,
    appSizes: appJs?.sizes ?? bootstrap.entryStatic.js,
    appOwnership: ownershipOf(appModules),
    appThirdParty: thirdPartyBreakdown(appModules),
    entryOwnership: ownershipOf(entryModules),
    entryThirdParty: thirdPartyBreakdown(entryModules),
    pageOwnership: ownershipOf(initialModules),
    totals: {
      'entry-static JS': bootstrap.entryStatic.js,
      'initial capability JS': bootstrap.initialCapabilities.js,
      'route/application JS': bootstrap.renderedRoute.js,
      'later/deferred JS': bootstrap.deferredOnly.js,
      'complete initial JS': bootstrap.completeInitialPage.js,
    },
    files: {
      entryStatic: bootstrap.entryStatic.files,
      initialCapabilities: bootstrap.initialCapabilities.files,
      renderedRoute: bootstrap.renderedRoute.files,
      deferredOnly: bootstrap.deferredOnly.files,
      completeInitial: bootstrap.completeInitialPage.files,
    },
    chunks: chunkRows,
    topModules,
    completeInitialModules,
    frameworkEntry: [...uniqueFramework.values()],
    duplicates: detectDuplicatePackages(allModules),
    initialDuplicates: detectDuplicatePackages(initialModules),
    bootstrapManifest: manifest,
    entryFrameworkSources: retainedFrameworkSources(audit, bootstrap.entryStatic),
    pageFrameworkSources: retainedFrameworkSources(audit, bootstrap.completeInitialPage),
    appUses,
    staticRetention: bootstrap.staticRetention,
  }
}

const dominantOwner = (modules: readonly ModuleRecord[]): BundleOwner => {
  const totals = new Map<BundleOwner, number>()
  for (const module of modules) totals.set(module.owner, (totals.get(module.owner) ?? 0) + module.renderedLength)
  return [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'bundler'
}

const jsonSafe = (value: unknown): unknown => {
  if (typeof value === 'function') return '[function]'
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]))
  }
  return value
}

const snapshotResolvedViteConfig = (config: ResolvedConfig) => ({
  configFile: config.configFile,
  configFileDependencies: config.configFileDependencies,
  mode: config.mode,
  command: config.command,
  isProduction: config.isProduction,
  base: config.base,
  root: config.root,
  plugins: config.plugins.map((plugin) => plugin.name).filter(Boolean),
  resolve: {
    alias: (Array.isArray(config.resolve.alias) ? config.resolve.alias : []).map((alias) => ({
      find: String(alias.find),
      replacement: alias.replacement,
    })),
    dedupe: config.resolve.dedupe,
  },
  define: jsonSafe(config.define),
  build: {
    minify: config.build.minify,
    cssMinify: config.build.cssMinify,
    cssCodeSplit: config.build.cssCodeSplit,
    sourcemap: config.build.sourcemap,
    target: config.build.target,
    outDir: config.build.outDir,
    assetsDir: config.build.assetsDir,
    emptyOutDir: config.build.emptyOutDir,
    modulePreload: jsonSafe(config.build.modulePreload),
    rollupOptions: {
      input: jsonSafe(config.build.rollupOptions.input),
      preserveEntrySignatures: config.build.rollupOptions.preserveEntrySignatures,
    },
  },
})

const observeLandingProduction = (
  onConfig: (config: ResolvedConfig) => void,
  onBundle: (bundle: OutputBundle) => void,
): Plugin => ({
  name: 'vue-ssr-lite:task-012-observe',
  enforce: 'post',
  configResolved(config) {
    onConfig(config)
  },
  generateBundle(_options, bundle) {
    onBundle(bundle)
  },
  writeBundle(_options, bundle) {
    onBundle(bundle)
  },
})

const availableCapabilityFiles = (capabilities: SsrBootstrapAssetManifest['applications'][string]['capabilities']) =>
  [...new Set(Object.values(capabilities).flatMap((files) => files ?? []))]

export const buildLandingProductionAudit = async (options: {
  frameworkRoot: string
  landingRoot: string
}) => {
  let collected: Audit | undefined
  let observedConfig: ReturnType<typeof snapshotResolvedViteConfig> | undefined
  let emittedBootstrap: SsrBootstrapAssetManifest | undefined
  let entrySource: string | undefined
  let emittedFiles: string[] = []
  const previousCwd = process.cwd()
  const landingRequire = createRequire(join(options.landingRoot, 'package.json'))
  const { build } = await import(pathToFileURL(landingRequire.resolve('vite')).href) as typeof import('vite')
  process.chdir(options.landingRoot)
  try {
    await build({
      root: options.landingRoot,
      plugins: [
        observeLandingProduction((config) => {
          observedConfig = snapshotResolvedViteConfig(config)
        }, (bundle) => {
          emittedFiles = Object.keys(bundle)
          for (const [fileName, item] of Object.entries(bundle)) {
            if (item.type !== 'asset') continue
            if (fileName !== SSR_BROWSER_BOOTSTRAP_METADATA_PATH && !fileName.endsWith('vue-ssr-lite-bootstrap.json')) continue
            const source = typeof item.source === 'string' ? item.source : Buffer.from(item.source).toString('utf8')
            emittedBootstrap = parseSsrBootstrapAssetManifest(source)
          }
          const entry = Object.values(bundle).find((item): item is OutputChunk => item.type === 'chunk' && item.isEntry)
          if (entry) entrySource = entry.code
        }),
        ssrBundleAudit(options.frameworkRoot, (audit) => { collected = audit }),
      ],
    })
  } finally {
    process.chdir(previousCwd)
  }
  if (!collected) throw new Error('Landing production client audit did not run.')
  if (!observedConfig) throw new Error('Landing production Vite configuration was not resolved.')
  if (!normalize(observedConfig.configFile ?? '').endsWith('vite.config.ts')) {
    throw new Error(`Landing audit must load the application's vite.config.ts, observed ${observedConfig.configFile}`)
  }
  const viteEntries = await resolveSsrViteEntries(options.landingRoot)
  const application = viteEntries.applications[0]
  if (!application) throw new Error('Landing application entry is missing.')
  const manifest = emittedBootstrap ?? collected.bootstrapManifest([{
    id: application.id,
    clientModuleId: `${RESOLVED_CLIENT_PREFIX}${application.id}`,
    initial: application.initialBootstrap ?? [],
  }])
  const applicationAssets = manifest.applications[application.id]
  if (!applicationAssets) throw new Error(`Landing bootstrap metadata is missing application ${application.id}.`)
  const flattenedFiles = availableCapabilityFiles(applicationAssets.capabilities)
  const cliDeployment = await snapshotLandingCliDeployment(options.landingRoot)
  let slash: LandingRequestEvidence
  let contrast: LandingRequestEvidence
  let renderLoader: LandingRenderLoader | { kind: 'unavailable'; error: string }
  try {
    const rendered = await renderLandingRequests({
      landingRoot: options.landingRoot,
      applicationId: application.id,
      seo: application.clientSeo,
      aliases: observedConfig.resolve.alias,
    })
    slash = rendered.slash
    contrast = rendered.contrast
    renderLoader = rendered.loader
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    slash = { kind: 'unavailable', path: '/', error: message }
    contrast = { kind: 'unavailable', path: '/solutions', error: message }
    renderLoader = { kind: 'unavailable', error: message }
  }
  const selectedKeys = slash.kind === 'authoritative-render'
    ? selectSsrBootstrapCapabilityKeys(applicationAssets.initial, slash.capabilities)
    : []
  const capabilityFiles = slash.kind === 'authoritative-render'
    ? selectSsrBootstrapCapabilityFiles(applicationAssets.capabilities, selectedKeys)
    : []
  let ssrManifest: CompleteInitialManifestEvidence
  if (slash.kind !== 'authoritative-render') {
    ssrManifest = { kind: 'unavailable', error: 'No authoritative / render.', unmatched: [] }
  } else {
    try {
      const manifestSource = await readFile(join(options.landingRoot, observedConfig.build.outDir, '.vite/ssr-manifest.json'), 'utf8')
      const mapped = routeAssetsFromRenderedModules(slash.renderedModules, parseSsrViteManifest(manifestSource), {
        applicationId: application.id,
        base: observedConfig.base || '/',
        root: options.landingRoot,
      })
      ssrManifest = { kind: 'resolved', ...mapped }
    } catch (error) {
      ssrManifest = {
        kind: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
        unmatched: slash.renderedModules.slice(),
      }
    }
  }
  const renderedRoute = {
    files: ssrManifest.kind === 'resolved' ? ssrManifest.files : [],
    css: ssrManifest.kind === 'resolved' ? ssrManifest.css : [],
    unmatched: ssrManifest.unmatched,
  }
  const entryStaticModuleIds = modulesIn(collected, collected.entries.map((entry) => entry.file)).map((module) => module.id)
  const claim = decideCompleteInitialClaim({
    requestKind: slash.kind === 'authoritative-render' ? 'authoritative-render' : 'unavailable',
    manifest: ssrManifest,
    entryStaticModuleIds,
    emittedFiles: [...new Set([...emittedFiles, ...collected.chunks.map((chunk) => chunk.file)])],
    selectedCapabilityFiles: capabilityFiles,
    selectedRouteFiles: renderedRoute.files,
    selectedRouteCss: renderedRoute.css,
    root: options.landingRoot,
  })
  const completeInitialClaim = claim.claim
  const report = analyzeProductionBundle(collected, {
    label: 'real landing application',
    frameworkRoot: options.frameworkRoot,
    entryFiles: collected.entries.map((entry) => entry.file),
    capabilityFiles,
    routeFiles: renderedRoute.files,
    routeCss: renderedRoute.css,
  })
  const appCompression = entrySource ? compressionProfiles(entrySource) : undefined
  const additivePlugins = (observedConfig.plugins ?? []).filter((name) => ADDITIVE_AUDIT_PLUGINS.includes(name as typeof ADDITIVE_AUDIT_PLUGINS[number]))
  return {
    audit: collected,
    report,
    installedPackage: JSON.parse(await readFile(join(options.landingRoot, 'node_modules/vue-ssr-lite/package.json'), 'utf8')).version as string,
    observedConfig,
    emittedBootstrap: manifest,
    completeInitialClaim,
    capabilityAccounting: {
      applicationId: application.id,
      applicationInitial: applicationAssets.initial,
      requestPath: '/',
      request: slash,
      contrastPath: '/solutions',
      contrastRequest: contrast,
      selectedKeys,
      selectedFiles: capabilityFiles,
      availableKeys: Object.keys(applicationAssets.capabilities),
      availableFiles: flattenedFiles,
      excludedFiles: flattenedFiles.filter((file) => !capabilityFiles.includes(file)),
      renderedModules: slash.kind === 'authoritative-render' ? slash.renderedModules : [],
      renderedRoute,
      ssrManifest: ssrManifest.kind === 'resolved'
        ? { kind: 'resolved' as const }
        : { kind: 'unavailable' as const, error: ssrManifest.error },
      claimReasons: claim.reasons,
      provenEntryStatic: claim.provenEntryStatic,
      unresolvedModules: claim.unresolvedModules,
      resolvedInitialBootstrap: application.initialBootstrap ?? [],
      installedPluginEmittedBootstrap: Boolean(emittedBootstrap),
      manifestSource: emittedBootstrap ? 'emitted-landing-plugin' : 'reconstructed-from-observed-bundle',
      additivePlugins,
      renderLoader,
      cliDeployment,
    },
    appCompression,
    networkTrace: TASK_011_PRODUCTION_NETWORK_TRACE,
  }
}

export const buildFixtureAttributionParity = async (options: {
  frameworkRoot: string
  consumerRoot: string
  reportRoot: string
}) => {
  const fixtureRoot = join(options.consumerRoot, 'node_modules/.cache/vue-ssr-lite/task-012/capability-consumer')
  await cp(join(options.frameworkRoot, 'fixtures/capability-consumer'), fixtureRoot, { recursive: true })
  const source = await buildSsrCapabilityMatrix({
    frameworkRoot: options.frameworkRoot,
    consumerRoot: options.consumerRoot,
    fixtureRoot,
    mode: 'source',
    profiles: COMPARISON_PROFILES,
    externalPeers: [false, true],
  })
  const installed = await buildSsrCapabilityMatrix({
    frameworkRoot: options.frameworkRoot,
    consumerRoot: options.consumerRoot,
    fixtureRoot,
    mode: 'installed',
    profiles: COMPARISON_PROFILES,
    externalPeers: [false, true],
  })
  return {
    source,
    installed,
    comparison: compareSsrCapabilityMatrices(source, installed),
  }
}

const ownershipLines = (ownership: Record<AuditOwner, number>) => {
  const total = sum(Object.values(ownership))
  return (Object.entries(ownership) as [AuditOwner, number][])
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([owner, value]) => `- ${owner}: ${value.toLocaleString()} renderedLength (${total ? ((value / total) * 100).toFixed(1) : '0.0'}%)`)
    .join('\n')
}

const sizeLine = (label: string, sizes: Sizes) =>
  `- ${label}: raw ${sizes.bytes.toLocaleString()} B · gzip (node zlib default) ${sizes.gzip.toLocaleString()} B · brotli (node zlib quality 11) ${sizes.brotli.toLocaleString()} B`

const metricLine = (label: string, metric: string, bytes: number, note?: string) =>
  `- ${label}: ${bytes.toLocaleString()} B [${metric}]${note ? ` — ${note}` : ''}`

const describeRenderLoader = (loader: Awaited<ReturnType<typeof buildLandingProductionAudit>>['capabilityAccounting']['renderLoader']) => {
  if (loader.kind === 'unavailable') {
    return `- module loader: **unavailable** — ${loader.error}`
  }
  return `- module loader: Vue + Tailwind + aliases observed from the production client config. Omitted \`${loader.omittedPlugins.join(', ')}\`. ${loader.reason} This still loads landing \`src/main.ts\` / \`src/App.vue\`, not a reconstructed route table.`
}

const describeRequestEvidence = (landing: Awaited<ReturnType<typeof buildLandingProductionAudit>>) => {
  const request = landing.capabilityAccounting.request
  const contrast = landing.capabilityAccounting.contrastRequest
  const rendered = landing.capabilityAccounting.renderedRoute
  const claimLines = landing.completeInitialClaim === 'exact'
    ? `- complete-initial claim: **exact** — authoritative \`/\` render, production SSR manifest parsed, rendered modules reconciled or proven entry-static, selected files present in the observed bundle, no external complete-initial resources.`
    : `- complete-initial claim: **not-claimed**
${landing.capabilityAccounting.claimReasons.map((reason) => `  - ${reason}`).join('\n') || '  - Unresolved complete-initial evidence.'}`
  if (request.kind !== 'authoritative-render') {
    return `- request evidence: **unavailable** — ${request.error}
${claimLines}
${describeRenderLoader(landing.capabilityAccounting.renderLoader)}
- installed plugin emitted Task 011 bootstrap metadata: ${landing.capabilityAccounting.installedPluginEmittedBootstrap ? 'yes' : 'no — vue-ssr-lite@' + landing.installedPackage + ' wrote \`.vite/vue-ssr-lite-assets.json\` only'}
- manifest source: ${landing.capabilityAccounting.manifestSource}`
  }
  return `- request evidence: **authoritative-render** — \`renderSsrApplication\` of the landing application's actual \`src/App.vue\` + \`src/main.ts\` routes/install, then \`readSsrRequestBootstrap\`
${describeRenderLoader(landing.capabilityAccounting.renderLoader)}
${claimLines}
- Task 011 request for \`/\`: ${request.capabilities.join(', ') || '(none)'}
- rendered modules for \`/\`: ${request.renderedModules.join(', ') || '(none)'}
- production SSR manifest: ${landing.capabilityAccounting.ssrManifest.kind === 'resolved' ? 'read and parsed' : `unavailable — ${landing.capabilityAccounting.ssrManifest.error}`}
- rendered-route JS from the production SSR manifest (not Home/PublicLayout/App filename regex): ${rendered.files.join(', ') || '(none — those modules have empty manifest entries / already live in the entry)'}
- rendered-route CSS: ${rendered.css.join(', ') || '(none)'}
- rendered modules not present in the production SSR manifest: ${rendered.unmatched.join(', ') || '(none)'}
- unmatched modules proven entry-static: ${landing.capabilityAccounting.provenEntryStatic.join(', ') || '(none)'}
- unresolved rendered modules: ${landing.capabilityAccounting.unresolvedModules.join(', ') || '(none)'}
- application.initial: ${landing.capabilityAccounting.applicationInitial.join(', ') || '(none)'}
- selected keys: ${landing.capabilityAccounting.selectedKeys.join(', ') || '(none)'}
- selected files: ${landing.capabilityAccounting.selectedFiles.join(', ') || '(none)'}
- available map keys: ${landing.capabilityAccounting.availableKeys.join(', ') || '(none)'}
- files in the map but **not** charged to \`/\`: ${landing.capabilityAccounting.excludedFiles.join(', ') || '(none)'}
- contrast \`${landing.capabilityAccounting.contrastPath}\`: ${contrast.kind === 'authoritative-render' ? contrast.capabilities.join(', ') || '(none)' : `unavailable — ${contrast.error}`}
- resolved \`application.initialBootstrap\`: ${landing.capabilityAccounting.resolvedInitialBootstrap.join(', ') || '(none)'}
- installed plugin emitted Task 011 bootstrap metadata: ${landing.capabilityAccounting.installedPluginEmittedBootstrap ? 'yes' : 'no — vue-ssr-lite@' + landing.installedPackage + ' wrote \`.vite/vue-ssr-lite-assets.json\` only; the capability **map** was reconstructed from the observed client graph with Task 011 \`createSsrBootstrapAssetManifest\`. Request keys are not reconstructed from a route table.'}
- manifest source: ${landing.capabilityAccounting.manifestSource}

${request.capabilities.includes('middleware')
    ? 'The landing render of `/` included middleware in `readSsrRequestBootstrap`, so middleware files are part of complete-initial.'
    : 'The landing render of `/` did **not** include middleware in `readSsrRequestBootstrap`. Middleware remains an available capability output and is not charged to `/` unless that request result includes it.'}`
}

const statusLines = (landing: Awaited<ReturnType<typeof buildLandingProductionAudit>>) => {
  const requestOk = landing.capabilityAccounting.request.kind === 'authoritative-render'
  if (requestOk && landing.completeInitialClaim === 'exact') {
    return `Task 012 methodology is complete for this revision: like-for-like metrics, landing Vite config with observe/audit plugins only (CLI deployment plugins proven empty/non-transforming for this target and not added), \`/\` request keys from \`renderSsrApplication\` + \`readSsrRequestBootstrap\` of the landing App/routes, production SSR-manifest route files, required source/installed attribution parity, and third-party duplicate inspection. Complete-initial raw/gzip/Brotli are exact for those selected local files only.

Task 012 is still investigation-only.`
  }
  const reasons = landing.capabilityAccounting.claimReasons
  return `Task 012 is **incomplete**. ${requestOk ? 'The \`/\` render is not sufficient for an exact complete-initial claim.' : 'The landing `/` request bootstrap was not obtained from \`renderSsrApplication\` + \`readSsrRequestBootstrap\`.'} Complete-initial \`/\` totals are not claimed.
${reasons.length ? reasons.map((reason) => `- ${reason}`).join('\n') : ''}

Task 012 is still investigation-only.`
}

const retainedModuleLine = (
  module: ReturnType<typeof analyzeProductionBundle>['completeInitialModules'][number],
  index: number,
) =>
  `${index + 1}. ${module.id} — ${module.renderedLength.toLocaleString()} renderedLength (${module.owner}${module.package ? `, ${module.package}` : ''}${module.file ? `; \`${module.file}\`` : ''})`

export const renderProductionRetentionMarkdown = (input: {
  landing: Awaited<ReturnType<typeof buildLandingProductionAudit>>
  fixtures: Awaited<ReturnType<typeof buildFixtureAttributionParity>>
  nuxt: Awaited<ReturnType<typeof inspectNuxtLandingProduction>>
  frameworkVersion: string
  node: string
}) => {
  const { landing, fixtures } = input
  const report = landing.report
  const sourceRows = fixtures.source.filter((row) => COMPARISON_PROFILES.includes(row.profile as typeof COMPARISON_PROFILES[number]))
  const framework = report.frameworkEntry
  const leads = rankLeads(report)
  const trace = landing.networkTrace
  const appBrotli = report.appSizes.brotli
  const completeBrotli = report.totals['complete initial JS'].brotli
  const appVsTrace = compareLikeForLike({ metric: 'brotli', bytes: appBrotli }, { metric: 'transferred', bytes: trace.appJs.bytes })
  const inspected = report.initialDuplicates.inspectedPackages
  return `# Task 012 — Production Bundle Attribution & Static Retention Audit

Investigation only. Benchmark consumer: \`/Users/safdar/Playground/nuxt-vue-ssr/landing\` (Vue 3 + Vite + vue-ssr-lite). Comparison implementation: \`/Users/safdar/Playground/nuxt-vue-ssr/nuxt-landing\`. This is **not** Builto landing. Apollo/vlite3/GraphQL findings from that other app are out of scope. This revision does not optimize either landing and does not open Task 013.

## Metric contract

These families are never interchangeable:

| Metric | What it measures | Encoder / source |
| --- | --- | --- |
| raw | Uncompressed file bytes | emitted JS bytes |
| gzip | Whole-file gzip | node zlib default |
| brotli | Whole-file Brotli | node zlib quality 11 unless labeled otherwise |
| transferred / network | Bytes on the wire | browser/CDN \`Content-Encoding\` + transfer size |

Module contribution is Rollup \`renderedLength\` (pre-minifier characters). Compressed bytes are never apportioned across mixed-owner files.

Task 011's **118,771 B** and **~163.9 KB** are **transferred / network** measurements from the production browser trace (\`app.js\` had \`content-encoding: br\`). They are not fixture raw sizes and are not a "framework floor" expressed as raw bytes.

Audited landing graph: Playground \`nuxt-vue-ssr/landing\` **actual resolved production Vite configuration**, with vue-ssr-lite@${landing.installedPackage} as installed by that app. Attribution uses Task 010 \`createSsrFrameworkSourceResolver\` / \`frameworkModuleSources\` / package \`module-attribution.json\` and Task 011 \`inspectSsrBundle\` / \`bootstrapReport\` / \`selectSsrBootstrapCapabilityKeys\`. Current workspace package version is ${input.frameworkVersion}. Node ${input.node}.

## 0. Observed production Vite configuration

The production client build loads the landing \`vite.config.ts\` through that application's installed Vite. The only plugins added by this audit are \`${ADDITIVE_AUDIT_PLUGINS.join('` and `')}\`. \`configFile: false\` is not used for that client build. Aliases, define values, minify, base, and Rollup options come from the resolved landing config.

Landing \`package.json\` \`build\` is \`vue-ssr-lite build\`. Installed vue-ssr-lite@${landing.installedPackage} spreads \`createDeploymentBuild(root).plugins\` into that CLI client build. Observed CLI deployment target: \`${landing.capabilityAccounting.cliDeployment.target}\`. Plugins that invocation would add: ${landing.capabilityAccounting.cliDeployment.plugins.length ? landing.capabilityAccounting.cliDeployment.plugins.map((name) => '`' + name + '`').join(', ') : '(none)'}. Module-graph effect: ${landing.capabilityAccounting.cliDeployment.moduleGraphEffect}. ${landing.capabilityAccounting.cliDeployment.note} This audit does **not** add those deployment plugins. Only observe/audit instrumentation is additive.

- config file: \`${landing.observedConfig.configFile}\`
- command / mode: ${landing.observedConfig.command} / ${landing.observedConfig.mode} (production=${landing.observedConfig.isProduction})
- base: \`${landing.observedConfig.base}\`
- minify: \`${String(landing.observedConfig.build.minify)}\`
- CSS minify: \`${String(landing.observedConfig.build.cssMinify)}\`
- outDir: \`${landing.observedConfig.build.outDir}\`
- modulePreload: \`${JSON.stringify(landing.observedConfig.build.modulePreload)}\`
- additive audit plugins: ${landing.capabilityAccounting.additivePlugins.join(', ') || '(none)'}
- resolved plugins: ${landing.observedConfig.plugins.join(', ')}
- resolve.dedupe: ${(landing.observedConfig.resolve.dedupe ?? []).join(', ') || '(none)'}
- aliases: ${landing.observedConfig.resolve.alias.map((alias) => `\`${alias.find}\` → \`${alias.replacement}\``).join('; ') || '(none)'}

## 1. Current initial-JS totals (audit metrics only)

These rows are the observed Playground landing production client graph. They are **not** the Task 011 network trace. When complete-initial is shown, those bytes are the exact whole-file raw/gzip/Brotli sums of the selected local files (entry + Task 011 keys + SSR-manifest route files). ${landing.capabilityAccounting.installedPluginEmittedBootstrap
    ? 'Installed vue-ssr-lite emitted Task 011 bootstrap metadata.'
    : `Installed vue-ssr-lite@${landing.installedPackage} did not emit \`.vite/vue-ssr-lite-bootstrap.json\`; the capability **map** was reconstructed from this observed graph. Request keys are not reconstructed.`}

${landing.completeInitialClaim === 'exact'
    ? sizeLine('complete initial JS (selected local files for landing /)', report.totals['complete initial JS'])
    : `- complete initial JS for \`/\`: **not claimed**. ${landing.capabilityAccounting.claimReasons.join(' ') || 'Complete-initial evidence is incomplete.'}`}
${sizeLine('main app JS (' + report.appFile + ')', report.appSizes)}
${sizeLine('entry-static JS', report.totals['entry-static JS'])}
${landing.completeInitialClaim === 'exact'
    ? sizeLine('initial capability JS (request-aware /)', report.totals['initial capability JS'])
    : '- initial capability JS for `/`: **not claimed**.'}
${landing.completeInitialClaim === 'exact'
    ? sizeLine('route/application JS (beyond entry-static/capabilities)', report.totals['route/application JS'])
    : '- route/application JS for `/`: **not claimed** (no rendered-module mapping from a landing render).'}
${sizeLine('later/deferred JS', report.totals['later/deferred JS'])}

${landing.appCompression ? `Entry-file compression profiles for \`${report.appFile}\` (same bytes, different encoders):
- raw: ${landing.appCompression.raw.bytes.toLocaleString()} B
- gzip (node default): ${landing.appCompression.gzipNodeDefault.bytes.toLocaleString()} B
- brotli quality 11 (node default, same family as audit \`brotli\`): ${landing.appCompression.brotliNodeQuality11.bytes.toLocaleString()} B
- brotli quality 5: ${landing.appCompression.brotliNodeQuality5.bytes.toLocaleString()} B
` : ''}

| File | Role | Raw | Gzip (node default) | Brotli (node q11) | Dominant owner |
| --- | --- | ---: | ---: | ---: | --- |
${report.chunks.map((chunk) => `| \`${chunk.file}\` | ${chunk.role} | ${chunk.bytes.toLocaleString()} | ${chunk.gzip.toLocaleString()} | ${chunk.brotli.toLocaleString()} | ${chunk.owner} |`).join('\n')}

Entry-static files: ${report.files.entryStatic.join(', ') || '(none)'}
Initial capability files for \`/\`: ${report.files.initialCapabilities.join(', ') || '(none)'}
Route/application files for \`/\`: ${report.files.renderedRoute.join(', ') || '(none — current route is inside the entry-static closure)'}
Deferred files: ${report.files.deferredOnly.join(', ') || '(none)'}

## 2. Reconciliation with the Task 011 production network trace

${metricLine('Task 011 app.js', 'transferred, content-encoding: br', trace.appJs.bytes, trace.appJs.note)}
${metricLine('Task 011 complete initial JS', 'transferred (approximate)', trace.completeInitialJs.bytes, trace.completeInitialJs.note)}
${metricLine('Task 011 Nuxt initial JS', trace.nuxtInitialJs.metric + ' (approximate)', trace.nuxtInitialJs.bytes, trace.nuxtInitialJs.note)}
${metricLine('This audit app.js', 'raw', report.appSizes.bytes)}
${metricLine('This audit app.js', 'brotli (node zlib quality 11)', report.appSizes.brotli)}
${landing.completeInitialClaim === 'exact' ? metricLine('This audit complete initial JS', 'raw', report.totals['complete initial JS'].bytes) : '- This audit complete initial JS: not claimed'}
${landing.completeInitialClaim === 'exact' ? metricLine('This audit complete initial JS', 'brotli (node zlib quality 11, sum of whole files)', completeBrotli) : ''}

Like-for-like status:

- raw ${report.appSizes.bytes.toLocaleString()} B vs transferred ${trace.appJs.bytes.toLocaleString()} B: **not comparable**.
- fixture raw sizes vs transferred ${trace.appJs.bytes.toLocaleString()} B: **not comparable**. The previous 116.8 KB fixture raw figure is not the 118.8 KB production transfer.
- node Brotli quality 11 of this \`app.js\` (${appBrotli.toLocaleString()} B) vs transferred ${trace.appJs.bytes.toLocaleString()} B: **same compression family, not the same encoder or artifact**. ${appVsTrace.comparable ? '' : 'The audit will not treat either figure as the other.'}
${landing.appCompression ? `- node Brotli quality 5 of this \`app.js\` is ${landing.appCompression.brotliNodeQuality5.bytes.toLocaleString()} B. CDN/browser quality is still unknown and is not assumed to match node zlib.` : ''}

${explainReconciliation(report.appSizes, completeBrotli, landing.appCompression, trace)}

Neither the Task 011 transfer nor this audit's raw/Brotli figures is declared authoritative until a like-for-like transferred measurement of **this same production output** is collected.

## 3. Initial capability accounting for \`/\`

Capability map files are **available outputs**. Complete-initial for \`/\` is claimed only when \`readSsrRequestBootstrap\` comes from \`renderSsrApplication\` of the landing application's actual \`App.vue\`, \`main.ts\` routes, and install function.

${describeRequestEvidence(landing)}

## 4. Breakdown of \`${report.appFile}\` by ownership

${ownershipLines(report.appOwnership)}

Third-party packages inside \`${report.appFile}\` (renderedLength):
${report.appThirdParty.length ? report.appThirdParty.map((item) => `- ${item.name}: ${item.renderedLength.toLocaleString()}`).join('\n') : '- (none)'}

Complete-initial ownership (all initial JS files, still renderedLength — not gzip or transfer shares):
${ownershipLines(report.pageOwnership)}

## 5. Every retained module in \`${report.appFile}\` by renderedLength

${report.topModules.map((module, index) => retainedModuleLine(module, index)).join('\n')}

## 5b. Every retained module in the complete-initial \`/\` graph

${report.completeInitialModules.map((module, index) => retainedModuleLine(module, index)).join('\n') || '- (none)'}

## 6. Static import/retention path for every complete-initial module

Paths are the Rollup static import chain from the generated browser entry facade. \`emitted-static-chunk\` means the module is in an entry-static file without a recorded static source edge (manual chunk / facade-less emit).

${report.completeInitialModules.map((module) => `### ${module.id} (${module.renderedLength.toLocaleString()} renderedLength, ${module.owner}${module.file ? `, \`${module.file}\`` : ''})
${module.path.length ? module.path.join('\n→ ') : '(no static path recorded — ' + module.retention + ')'}`).join('\n\n')}

## 7. Remaining vue-ssr-lite static modules

Every meaningful vue-ssr-lite source still in the entry/static closure:

${framework.map((item) => `- \`${item.source}\` — ${item.classification} — ${item.renderedLength.toLocaleString()} renderedLength
  ${item.reason}
  ${item.path.length ? item.path.join(' → ') : item.retention}`).join('\n')}

## 8. Fixture comparison (raw / gzip / Brotli kept separate)

Fixture rows are capability-consumer graphs, not the production network trace. Source mode aliases vue-ssr-lite to the current workspace. Installed mode uses the landing consumer's \`node_modules/vue-ssr-lite@${landing.installedPackage}\` and Task 010 \`module-attribution.json\`. Both modes resolve Vue/Vite peers from the landing consumer.

| Consumer | Mode | Peers | Entry-static raw | Entry-static gzip | Entry-static brotli | Framework renderedLength |
| --- | --- | --- | ---: | ---: | ---: | ---: |
${sourceRows.map((row) => fixtureTableRow(row, 'source')).join('\n')}
${fixtures.installed.filter((row) => COMPARISON_PROFILES.includes(row.profile as typeof COMPARISON_PROFILES[number])).map((row) => fixtureTableRow(row, 'installed')).join('\n')}
| real landing / | installed package ${landing.installedPackage} | bundled by landing Vite config | ${report.totals['entry-static JS'].bytes.toLocaleString()} | ${report.totals['entry-static JS'].gzip.toLocaleString()} | ${report.totals['entry-static JS'].brotli.toLocaleString()} | ${report.entryOwnership['vue-ssr-lite'].toLocaleString()} |

Source/installed attribution comparison (Task 010/011 \`compareSsrCapabilityMatrices\`):
${fixtures.comparison.map((row) => `- ${row.profile} peers=${row.externalPeers ? 'external' : 'bundled'}: source raw ${row.source.bytes.toLocaleString()} B vs installed raw ${row.installed.bytes.toLocaleString()} B (raw Δ ${row.delta.bytes.toLocaleString()} B; gzip Δ ${row.delta.gzip.toLocaleString()} B; brotli Δ ${row.delta.brotli.toLocaleString()} B). Semantic capability sources matched.`).join('\n')}

Landing production audit did **not** alias vue-ssr-lite back to repository source.

## 9. Duplicate dependency findings

Every package with renderedLength in the complete-initial graph was inspected, including material third parties (Iconify, carousel, tooltip, and others). "None" here means no package had two resolved roots, not that only Vue was checked. Builto Apollo/vlite3 packages are not part of this benchmark.

Packages inspected in the complete-initial graph:
${inspected.length ? inspected.map((item) => `- ${item.name}: ${item.renderedLength.toLocaleString()} renderedLength, ${item.roots.length} root${item.roots.length === 1 ? '' : 's'}${item.roots.length > 1 ? ` (${item.roots.join(' AND ')})` : ''}`).join('\n') : '- (no node_modules packages in the initial graph)'}

Duplicate package roots in the full client graph:
${report.duplicates.packages.length ? report.duplicates.packages.map((item) => `- ${item.name} (${item.renderedLength.toLocaleString()} renderedLength) resolved from ${item.roots.join(' AND ')}`).join('\n') : '- None. Each inspected package has one resolved root in this graph.'}

Duplicate package roots in the complete-initial graph:
${report.initialDuplicates.packages.length ? report.initialDuplicates.packages.map((item) => `- ${item.name} resolved from ${item.roots.join(' AND ')}`).join('\n') : '- None among complete-initial packages.'}

vue-ssr-lite source identities with more than one module id:
${report.duplicates.frameworkSources.length ? report.duplicates.frameworkSources.map((item) => `- ${item.source}: ${item.moduleIds.join(' | ')}`).join('\n') : '- None. Each retained framework source maps to one module id.'}

## 10. Qualitative leads (not Task 013 decisions)

These remain useful if they still appear on this Playground landing graph. They are not an optimization plan and are not Builto Apollo/vlite3 findings.

${leads.length ? leads.map((item, index) => `${index + 1}. **${item.title}**
   ${item.evidence}`).join('\n\n') : '- No application/third-party entry-static leads above the reporting threshold.'}

## 11. Nuxt landing comparison (\`nuxt-vue-ssr/nuxt-landing\`)

${renderNuxtComparisonMarkdown(input.nuxt)}

## STATUS

${statusLines(landing)}

Task 013 is **not** opened. Do not optimize, split, defer, or change capability preload architecture from this report.
`
}

const fixtureTableRow = (
  row: Awaited<ReturnType<typeof buildSsrCapabilityMatrix>>[number],
  mode: string,
) => {
  const ownership = row.entryStatic.renderedLengthByOwner
  const framework = sum(Object.entries(ownership).filter(([key]) => key.startsWith('framework-')).map(([, value]) => value ?? 0))
  return `| ${row.profile} fixture | ${mode} | ${row.externalPeers ? 'external' : 'bundled'} | ${row.entryStatic.js.bytes.toLocaleString()} | ${row.entryStatic.js.gzip.toLocaleString()} | ${row.entryStatic.js.brotli.toLocaleString()} | ${framework.toLocaleString()} |`
}

const explainReconciliation = (
  appSizes: Sizes,
  completeBrotli: number,
  profiles: ReturnType<typeof compressionProfiles> | undefined,
  trace: typeof TASK_011_PRODUCTION_NETWORK_TRACE,
) => {
  const reasons = [
    `The Task 011 ${trace.appJs.bytes.toLocaleString()} B figure is a **transferred** Brotli response body for a deployed \`app.js\`. This audit's ${appSizes.bytes.toLocaleString()} B figure is **raw** emitted bytes of the local production client entry.`,
    `This audit's node-zlib Brotli quality 11 of that entry is ${appSizes.brotli.toLocaleString()} B. A CDN or browser may use a different Brotli quality, dictionary, or wrapping; that still would not make raw ${appSizes.bytes.toLocaleString()} B equal ${trace.appJs.bytes.toLocaleString()} B.`,
  ]
  if (profiles) {
    const q11 = profiles.brotliNodeQuality11.bytes
    const q5 = profiles.brotliNodeQuality5.bytes
    if (q11 === trace.appJs.bytes) {
      reasons.push(`Node Brotli quality 11 of this local entry equals the Task 011 transfer. That would reconcile encoder+artifact for \`app.js\` only; complete-initial still needs its own transferred measurement.`)
    } else if (Math.abs(q11 - trace.appJs.bytes) / trace.appJs.bytes < 0.05) {
      reasons.push(`Node Brotli quality 11 of this local entry (${q11.toLocaleString()} B) is within 5% of the Task 011 transfer. Remaining difference can be encoder settings, deployed-vs-local source, or a different \`vue-ssr-lite\` version.`)
    } else {
      reasons.push(`Node Brotli quality 11 (${q11.toLocaleString()} B) and quality 5 (${q5.toLocaleString()} B) of this local entry both differ from the Task 011 transfer (${trace.appJs.bytes.toLocaleString()} B) by more than a typical quality-only gap. The deployed artifact is therefore not explained as "the same file, different metric label" alone. Possible remaining causes: different landing commit or dependency versions, different Vite/plugin output, or the trace measuring a different JS resource than this entry.`)
    }
  }
  reasons.push(`Complete-initial Brotli here is the **sum of whole-file** node-zlib quality 11 sizes (${completeBrotli.toLocaleString()} B), not one concatenated compression and not a network transfer.`)
  return reasons.map((reason) => `- ${reason}`).join('\n')
}

const pageThirdParty = (landing: ReturnType<typeof analyzeProductionBundle>) => {
  const totals = new Map<string, number>()
  for (const module of landing.completeInitialModules) {
    if (module.owner !== 'third-party dependency' || !module.package) continue
    totals.set(module.package, (totals.get(module.package) ?? 0) + module.renderedLength)
  }
  return [...totals.entries()].map(([name, renderedLength]) => ({ name, renderedLength }))
}

const rankLeads = (landing: ReturnType<typeof analyzeProductionBundle>) => {
  const items: { title: string; evidence: string; bytes: number }[] = []
  const third = [...landing.appThirdParty, ...pageThirdParty(landing)]
  const iconify = third.find((item) => item.name === '@iconify/vue' || item.name.startsWith('@iconify/'))
  const carousel = third.find((item) => item.name === 'vue-carousel-lite')
  const tooltip = third.find((item) => item.name === 'v-tooltip-lite')
  const i18nJson = landing.completeInitialModules.filter((module) =>
    /\.json$/.test(module.moduleId) && /translation|i18n|locales/i.test(module.moduleId))
  const i18nBytes = sum(i18nJson.map((module) => module.renderedLength))
  if (iconify) items.push({
    title: 'Global Icon registers @iconify/vue on the entry',
    evidence: `@iconify/vue contributes ${iconify.renderedLength.toLocaleString()} renderedLength. Landing \`main.ts\` does \`app.component('Icon', Icon)\` with \`Icon.vue\` importing \`@iconify/vue\`.`,
    bytes: iconify.renderedLength,
  })
  if (i18nBytes) items.push({
    title: 'Both locale catalogs are statically imported by createI18n',
    evidence: `Translation JSON in the complete-initial graph contributes ${i18nBytes.toLocaleString()} renderedLength (${i18nJson.map((module) => module.id).join(', ')}). \`src/i18n/index.ts\` is used from \`main.ts\` and statically imports \`translations/en.json\` and \`translations/ar.json\`.`,
    bytes: i18nBytes,
  })
  if (carousel) items.push({
    title: 'vue-carousel-lite on the Home tree',
    evidence: `vue-carousel-lite contributes ${carousel.renderedLength.toLocaleString()} renderedLength. \`Carousel.vue\` imports the package; Home is a lazy route.`,
    bytes: carousel.renderedLength,
  })
  if (tooltip) items.push({
    title: 'v-tooltip-lite retention',
    evidence: `v-tooltip-lite contributes ${tooltip.renderedLength.toLocaleString()} renderedLength via \`Dropdown.vue\`.`,
    bytes: tooltip.renderedLength,
  })
  return items.sort((a, b) => b.bytes - a.bytes).slice(0, 5)
}

export const runTask012ProductionRetentionAudit = async (options: {
  frameworkRoot: string
  landingRoot: string
  nuxtRoot: string
  reportRoot: string
}) => {
  await mkdir(options.reportRoot, { recursive: true })
  const frameworkVersion = JSON.parse(await readFile(join(options.frameworkRoot, 'package.json'), 'utf8')).version
  const landing = await buildLandingProductionAudit({
    frameworkRoot: options.frameworkRoot,
    landingRoot: options.landingRoot,
  })
  const nuxt = await inspectNuxtLandingProduction(options.nuxtRoot)
  let fixtures: Awaited<ReturnType<typeof buildFixtureAttributionParity>>
  try {
    fixtures = await buildFixtureAttributionParity({
      frameworkRoot: options.frameworkRoot,
      consumerRoot: options.landingRoot,
      reportRoot: options.reportRoot,
    })
  } catch (error) {
    await writeFile(join(options.reportRoot, 'TASK-012-PRODUCTION-BUNDLE-AUDIT.md'), `# Task 012 — INCOMPLETE

Source/installed attribution parity failed. Task 012 methodology is not complete.

${error instanceof Error ? error.stack ?? error.message : String(error)}
`)
    throw error
  }
  await writeFile(join(options.reportRoot, 'fixture-capabilities.json'), JSON.stringify({
    source: fixtures.source.map((row) => ({
      profile: row.profile, externalPeers: row.externalPeers, mode: row.mode,
      entryStatic: row.entryStatic.js, completeInitial: row.page.js,
      renderedLengthByOwner: row.entryStatic.renderedLengthByOwner,
      entryFrameworkSources: row.entryFrameworkSources,
    })),
    installed: fixtures.installed.map((row) => ({
      profile: row.profile, externalPeers: row.externalPeers, mode: row.mode,
      entryStatic: row.entryStatic.js, completeInitial: row.page.js,
      renderedLengthByOwner: row.entryStatic.renderedLengthByOwner,
      entryFrameworkSources: row.entryFrameworkSources,
    })),
    comparison: fixtures.comparison,
  }, null, 2))
  const payload = {
    version: 2,
    note: 'Whole-file raw/gzip/brotli are exact for these outputs. Task 011 118,771 B is a transferred network measurement, not raw. Module ownership uses pre-minifier renderedLength.',
    node: process.version,
    frameworkVersion,
    installedLandingPackage: landing.installedPackage,
    completeInitialClaim: landing.completeInitialClaim,
    observedConfig: landing.observedConfig,
    capabilityAccounting: landing.capabilityAccounting,
    appCompression: landing.appCompression,
    networkTrace: landing.networkTrace,
    landing: landing.report,
    nuxt,
  }
  await writeFile(join(options.reportRoot, 'landing-production-audit.json'), JSON.stringify(payload, null, 2))
  await writeFile(join(options.reportRoot, 'nuxt-landing-audit.json'), JSON.stringify({
    buildError: nuxt.buildError,
    files: nuxt.files,
    entryFiles: nuxt.entryFiles,
    homeInitialFiles: nuxt.homeInitialFiles,
    homeInitialJs: nuxt.homeInitialJs,
    homeInitialClaim: nuxt.homeInitialClaim,
    localeJson: nuxt.localeJson,
    liteLocaleSource: nuxt.liteLocaleSource,
    totalJs: nuxt.totalJs,
    networkTrace: nuxt.networkTrace,
  }, null, 2))
  const markdown = renderProductionRetentionMarkdown({
    landing,
    fixtures,
    nuxt,
    frameworkVersion,
    node: process.version,
  })
  const markdownPath = join(options.reportRoot, 'TASK-012-PRODUCTION-BUNDLE-AUDIT.md')
  await writeFile(markdownPath, markdown)
  return {
    markdownPath,
    reportRoot: options.reportRoot,
    landing: landing.report,
    capabilityAccounting: landing.capabilityAccounting,
    completeInitialClaim: landing.completeInitialClaim,
  }
}
