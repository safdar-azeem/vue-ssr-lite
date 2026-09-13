import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  TASK_011_PRODUCTION_NETWORK_TRACE,
  auditOwner,
  buildLandingProductionAudit,
  normalizeAuditModuleId,
  type AuditOwner,
} from './SsrProductionRetentionAudit'
import { inspectNuxtLandingProduction } from './SsrProductionNuxtComparison'

const execFileAsync = promisify(execFile)

type Sizes = { bytes: number; gzip: number; brotli: number }
type LandingAudit = Awaited<ReturnType<typeof buildLandingProductionAudit>>
type NuxtAudit = Awaited<ReturnType<typeof inspectNuxtLandingProduction>>
type Audit = LandingAudit['audit']

/** Task 012 local measurements. Historical only. Do not rewrite. */
export const TASK_012_HISTORICAL_LOCAL = {
  source: 'Task 012 local production audit of Playground nuxt-vue-ssr/landing before Task 013 application normalization',
  metricFamily: 'local-file raw / node-zlib gzip default / node-zlib brotli quality 11',
  appJs: { bytes: 347_975, gzip: 112_802, brotli: 97_483 },
  completeInitial: { bytes: 483_138, gzip: 155_443, brotli: 134_780 },
  appFile: 'assets/app-yyqjW65N.js',
  appOwnership: {
    Vue: 251_503,
    'application code': 186_011,
    'Vue Router': 62_882,
    'vue-ssr-lite': 48_771,
    'third-party dependency': 48_708,
    'unknown/unattributed': 5_493,
  } satisfies Record<AuditOwner, number>,
  completeInitialOwnership: {
    'application code': 318_824,
    Vue: 251_503,
    'third-party dependency': 126_586,
    'vue-ssr-lite': 77_346,
    'Vue Router': 62_882,
    'unknown/unattributed': 5_652,
  } satisfies Record<AuditOwner, number>,
  entryAsymmetries: {
    'translations/en.json': 156_546,
    'translations/ar.json': 22_889,
    '@iconify/vue': 48_708,
  },
  nuxt: {
    entryFile: '_nuxt/CmxF0VQJ.js',
    entry: { bytes: 196_749, gzip: 73_606, brotli: 65_617 },
    structuralSlash: { bytes: 334_951, gzip: 117_584, brotli: 104_366 },
    chromeFile: '_nuxt/BoKSYUaE.js',
    homeFile: '_nuxt/D9CsXh-w.js',
  },
} as const

const emptySizes = (): Sizes => ({ bytes: 0, gzip: 0, brotli: 0 })
const addSizes = (left: Sizes, right: Sizes): Sizes => ({
  bytes: left.bytes + right.bytes,
  gzip: left.gzip + right.gzip,
  brotli: left.brotli + right.brotli,
})
const deltaSizes = (after: Sizes, before: Sizes): Sizes => ({
  bytes: after.bytes - before.bytes,
  gzip: after.gzip - before.gzip,
  brotli: after.brotli - before.brotli,
})
const asSizes = (value: { bytes: number; gzip: number; brotli: number }): Sizes => ({
  bytes: value.bytes,
  gzip: value.gzip,
  brotli: value.brotli,
})
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)
const normalize = (id: string) => id.replaceAll('\\', '/')
const packageName = (id: string): string | undefined => {
  const path = normalize(id).split('?', 1)[0]!
  const index = path.lastIndexOf('/node_modules/')
  if (index < 0) return undefined
  const rest = path.slice(index + '/node_modules/'.length)
  if (!rest || rest.startsWith('.')) return undefined
  return rest.startsWith('@') ? rest.split('/').slice(0, 2).join('/') : rest.split('/')[0]
}
const localeCode = (id: string) => normalize(id).match(/\/translations\/(en|ar)\.json(?:\?|$)/)?.[1]
const isLocaleModule = (id: string) => Boolean(localeCode(id))
const isPackage = (id: string, name: string) => packageName(id) === name

const sizeLine = (label: string, sizes: Sizes) =>
  `- ${label}: raw ${sizes.bytes.toLocaleString()} B · gzip (node zlib default) ${sizes.gzip.toLocaleString()} B · brotli (node zlib quality 11) ${sizes.brotli.toLocaleString()} B`

const deltaLine = (label: string, delta: Sizes) =>
  `- ${label}: raw ${signed(delta.bytes)} B · gzip ${signed(delta.gzip)} B · brotli ${signed(delta.brotli)} B`

const signed = (value: number) => `${value > 0 ? '+' : ''}${value.toLocaleString()}`

const ownershipLines = (ownership: Record<AuditOwner, number>) => {
  const total = sum(Object.values(ownership))
  return (Object.entries(ownership) as [AuditOwner, number][])
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([owner, value]) => `- ${owner}: ${value.toLocaleString()} renderedLength (${total ? ((value / total) * 100).toFixed(1) : '0.0'}%)`)
    .join('\n')
}

const ownershipDeltaLines = (after: Record<AuditOwner, number>, before: Record<AuditOwner, number>) =>
  (Object.keys({ ...before, ...after }) as AuditOwner[])
    .map((owner) => ({ owner, delta: (after[owner] ?? 0) - (before[owner] ?? 0) }))
    .filter((item) => item.delta !== 0)
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .map((item) => `- ${item.owner}: ${signed(item.delta)} renderedLength`)
    .join('\n') || '- (no ownership movement)'

const modulesInFiles = (audit: Audit, files: ReadonlySet<string> | readonly string[]) => {
  const wanted = files instanceof Set ? files : new Set(files)
  return audit.chunks.filter((chunk) => wanted.has(chunk.file)).flatMap((chunk) =>
    chunk.modules.filter((module) => module.renderedLength > 0).map((module) => ({
      ...module,
      file: chunk.file,
      ownerLabel: auditOwner(module.owner),
      package: packageName(module.id),
    })))
}

const locatePackage = (audit: Audit, name: string, completeInitial: readonly string[]) => {
  const initial = new Set(completeInitial)
  const modules = audit.chunks.flatMap((chunk) =>
    chunk.modules.filter((module) => module.renderedLength > 0 && isPackage(module.id, name)).map((module) => ({
      id: module.id,
      file: chunk.file,
      renderedLength: module.renderedLength,
      entry: chunk.entry,
      completeInitial: initial.has(chunk.file),
    })))
  const files = [...new Set(modules.map((module) => module.file))]
  return {
    name,
    renderedLength: sum(modules.map((module) => module.renderedLength)),
    files,
    inEntry: modules.some((module) => module.entry),
    inCompleteInitial: modules.some((module) => module.completeInitial),
    modules,
  }
}

const locateLocales = (audit: Audit, completeInitial: readonly string[]) => {
  const initial = new Set(completeInitial)
  const modules = audit.chunks.flatMap((chunk) =>
    chunk.modules.filter((module) => module.renderedLength > 0 && isLocaleModule(module.id)).map((module) => ({
      code: localeCode(module.id)!,
      id: module.id,
      file: chunk.file,
      renderedLength: module.renderedLength,
      entry: chunk.entry,
      completeInitial: initial.has(chunk.file),
      sizes: chunk.sizes,
    })))
  return {
    modules,
    files: [...new Set(modules.map((module) => module.file))],
    inEntry: modules.filter((module) => module.entry).map((module) => module.code),
    inCompleteInitial: modules.filter((module) => module.completeInitial).map((module) => module.code),
  }
}

const fileRole = (
  file: string,
  files: LandingAudit['report']['files'],
  installAwaited: readonly string[] = [],
) => {
  if (files.entryStatic.includes(file)) return 'entry-static'
  if (files.initialCapabilities.includes(file)) return 'initial-capability'
  if (files.renderedRoute.includes(file)) return 'rendered-route'
  if (installAwaited.includes(file)) return 'install-awaited-bootstrap'
  if (files.completeInitial.includes(file)) return 'task-012-file-set'
  if (files.deferredOnly.includes(file)) return 'later/deferred'
  return 'other'
}

const moduleIdKeys = (id: string, root: string) => {
  const stripped = normalize(id).replace(/^file:\/\//, '').replace(/^\/@fs/, '').split('?', 1)[0]!.replace(/^\0+/, '')
  return [...new Set([
    normalizeAuditModuleId(id, root),
    normalizeAuditModuleId(stripped, root),
    stripped,
  ])]
}

const moduleIdsOverlap = (left: string, right: string, root: string) => {
  const keys = new Set(moduleIdKeys(left, root))
  return moduleIdKeys(right, root).some((key) => keys.has(key))
}

/**
 * Client files for entry-static `import()` targets that the authoritative `/`
 * render actually evaluated. No hashed locale filename matching.
 */
export const selectInstallAwaitedClientFiles = (input: {
  loadedModuleIds: readonly string[]
  entryDynamicImportIds: readonly string[]
  chunks: Audit['chunks']
  accountedFiles: readonly string[]
  root: string
}) => {
  const awaitedModuleIds = [...new Set(input.entryDynamicImportIds.filter((id) =>
    input.loadedModuleIds.some((loaded) => moduleIdsOverlap(id, loaded, input.root))))]
  const files: string[] = []
  const unmatched: string[] = []
  for (const id of awaitedModuleIds) {
    const chunk = input.chunks.find((item) => item.modules.some((module) =>
      module.renderedLength > 0 && moduleIdsOverlap(module.id, id, input.root)))
    if (!chunk) {
      unmatched.push(id)
      continue
    }
    if (!input.accountedFiles.includes(chunk.file) && !files.includes(chunk.file)) files.push(chunk.file)
  }
  return { awaitedModuleIds, files, unmatched }
}

const inspectNuxtLocaleReferences = (nuxt: NuxtAudit) => {
  const hits = nuxt.files.filter((item) => item.containsTranslationPath)
  const englishJson = nuxt.localeJson.filter((item) =>
    item.file === 'translations/en.json' || item.file === '_locales/general/en/data.json' || item.file === 'translations/home/en.json')
  return {
    jsFilesWithTranslationStrings: hits.map((item) => item.file),
    publishedEnglish: englishJson,
    publishedEnglishTotal: englishJson.reduce((total, item) => addSizes(total, item), emptySizes()),
    defaultCatalog: nuxt.localeJson.find((item) => item.file === 'translations/en.json'),
  }
}

export const analyzeLikeForLikeExtras = (landing: LandingAudit, nuxt: NuxtAudit) => {
  const report = landing.report
  const locales = locateLocales(landing.audit, report.files.completeInitial)
  const iconify = locatePackage(landing.audit, '@iconify/vue', report.files.completeInitial)
  const carousel = locatePackage(landing.audit, 'vue-carousel-lite', report.files.completeInitial)
  const tooltip = locatePackage(landing.audit, 'v-tooltip-lite', report.files.completeInitial)
  const englishLocaleFiles = [...new Set(locales.modules.filter((module) => module.code === 'en').map((module) => module.file))]
  const arabicLocaleFiles = [...new Set(locales.modules.filter((module) => module.code === 'ar').map((module) => module.file))]
  const request = landing.capabilityAccounting.request
  const loadedModuleIds = request.kind === 'authoritative-render' ? request.loadedModuleIds : []
  const entryDynamicImportIds = [...new Set(
    landing.audit.chunks
      .filter((chunk) => report.files.entryStatic.includes(chunk.file))
      .flatMap((chunk) => chunk.modules.flatMap((module) => module.dynamicImports)),
  )]
  const installAwaited = selectInstallAwaitedClientFiles({
    loadedModuleIds,
    entryDynamicImportIds,
    chunks: landing.audit.chunks,
    accountedFiles: report.files.completeInitial,
    root: landing.observedConfig.root,
  })
  const installAwaitedChunks = landing.audit.chunks.filter((chunk) => installAwaited.files.includes(chunk.file))
  const installAwaitedJs = installAwaitedChunks.reduce((total, chunk) => addSizes(total, chunk.sizes), emptySizes())
  const structuralJs = report.totals['complete initial JS']
  const firstStartupJs = addSizes(structuralJs, installAwaitedJs)
  const firstStartupFiles = [...report.files.completeInitial, ...installAwaited.files]
  const firstStartupOwnership = (() => {
    const ownership = { ...report.pageOwnership }
    for (const module of modulesInFiles(landing.audit, installAwaited.files)) {
      ownership[module.ownerLabel] = (ownership[module.ownerLabel] ?? 0) + module.renderedLength
    }
    return ownership
  })()
  const firstStartupClaim = landing.completeInitialClaim === 'exact'
    && request.kind === 'authoritative-render'
    && loadedModuleIds.length > 0
    && installAwaited.unmatched.length === 0
    && installAwaited.files.length > 0
    ? 'exact' as const
    : 'not-claimed' as const
  const switchOnlyLocaleFiles = arabicLocaleFiles.filter((file) => !firstStartupFiles.includes(file) && !report.files.completeInitial.includes(file))
  const nuxtLocale = inspectNuxtLocaleReferences(nuxt)
  const nuxtJsPlusDefaultCatalog = nuxt.homeInitialJs && nuxtLocale.defaultCatalog
    ? addSizes(nuxt.homeInitialJs, nuxtLocale.defaultCatalog)
    : nuxt.homeInitialJs
  const entryNormalized = locales.inEntry.length === 0 && !iconify.inEntry
  const legitimateRouteDepsPreserved = carousel.inCompleteInitial && tooltip.inCompleteInitial
  return {
    locales,
    iconify,
    carousel,
    tooltip,
    englishLocaleFiles,
    arabicLocaleFiles,
    switchOnlyLocaleFiles,
    installAwaited,
    installAwaitedJs,
    firstStartupJs,
    firstStartupFiles,
    firstStartupOwnership,
    firstStartupClaim,
    firstPaintLocale: installAwaitedJs,
    vueFirstPaintJsPlusLocale: firstStartupJs,
    nuxtLocale,
    nuxtJsPlusDefaultCatalog,
    entryNormalized,
    legitimateRouteDepsPreserved,
    observedIconPlugin: (landing.observedConfig.plugins ?? []).includes('landing-icon-usage-import'),
    fileRoles: landing.audit.chunks.map((chunk) => ({
      file: chunk.file,
      role: fileRole(chunk.file, report.files, installAwaited.files),
      ...chunk.sizes,
      entry: chunk.entry,
    })),
  }
}

const describeRequest = (landing: LandingAudit, extras: ReturnType<typeof analyzeLikeForLikeExtras>) => {
  const request = landing.capabilityAccounting.request
  const rendered = landing.capabilityAccounting.renderedRoute
  if (request.kind !== 'authoritative-render') {
    return `- request evidence: **unavailable** — ${request.error}
- Task 012 file-set claim (entry + capabilities + rendered-route JS): **${landing.completeInitialClaim}**
- first-startup JS claim (that file-set plus install-awaited dynamic JS): **${extras.firstStartupClaim}**`
  }
  return `- request evidence: **authoritative-render** — \`renderSsrApplication\` of the landing \`App.vue\` + \`main.ts\` routes/install, then \`readSsrRequestBootstrap\`
- Task 012 file-set claim (entry + selected capabilities + SSR-manifest rendered-route JS only): **${landing.completeInitialClaim}**${landing.capabilityAccounting.claimReasons.length ? `\n${landing.capabilityAccounting.claimReasons.map((reason) => `  - ${reason}`).join('\n')}` : ''}
- first-startup JS claim: **${extras.firstStartupClaim}** — Task 012 file-set plus client files for entry-static \`import()\` targets that this \`/\` render actually evaluated
- evaluated Vite module ids after \`/\`: ${request.loadedModuleIds.length.toLocaleString()}
- install-awaited source modules: ${extras.installAwaited.awaitedModuleIds.join(', ') || '(none)'}
- install-awaited extra client files: ${extras.installAwaited.files.join(', ') || '(none)'}
- install-awaited modules with no client chunk: ${extras.installAwaited.unmatched.join(', ') || '(none)'}
- Task 011 request keys for \`/\`: ${request.capabilities.join(', ') || '(none)'}
- rendered modules for \`/\`: ${request.renderedModules.join(', ') || '(none)'}
- rendered-route JS: ${rendered.files.join(', ') || '(none)'}
- rendered-route CSS: ${rendered.css.join(', ') || '(none)'}
- unmatched rendered modules: ${rendered.unmatched.join(', ') || '(none)'}
- selected capability keys: ${landing.capabilityAccounting.selectedKeys.join(', ') || '(none)'}
- selected capability files: ${landing.capabilityAccounting.selectedFiles.join(', ') || '(none)'}
- files available but not charged to \`/\`: ${landing.capabilityAccounting.excludedFiles.join(', ') || '(none)'}`
}

const retainedLines = (modules: LandingAudit['report']['topModules'], limit = 40) =>
  modules.slice(0, limit).map((module, index) =>
    `${index + 1}. ${module.id} — ${module.renderedLength.toLocaleString()} renderedLength (${module.owner}${module.package ? `, ${module.package}` : ''}${module.file ? `; \`${module.file}\`` : ''})`).join('\n')

const pathLines = (modules: LandingAudit['report']['completeInitialModules'], limit = 25) =>
  modules.slice(0, limit).map((module) =>
    `- ${module.id} (${module.renderedLength.toLocaleString()} renderedLength, \`${module.file}\`): ${module.path.length ? module.path.join(' → ') : module.retention}`).join('\n')

export const renderLikeForLikeMarkdown = (input: {
  landing: LandingAudit
  nuxt: NuxtAudit
  extras: ReturnType<typeof analyzeLikeForLikeExtras>
  frameworkVersion: string
  node: string
}) => {
  const { landing, nuxt, extras } = input
  const report = landing.report
  const historical = TASK_012_HISTORICAL_LOCAL
  const appDelta = deltaSizes(report.appSizes, historical.appJs)
  const completeDelta = landing.completeInitialClaim === 'exact'
    ? deltaSizes(report.totals['complete initial JS'], historical.completeInitial)
    : undefined
  const nuxtEntry = nuxt.entryFiles[0]
  const nuxtEntryDelta = nuxtEntry ? deltaSizes(asSizes(nuxtEntry), historical.nuxt.entry) : undefined
  const nuxtSlashDelta = nuxt.homeInitialClaim === 'structural-local'
    ? deltaSizes(nuxt.homeInitialJs, historical.nuxt.structuralSlash)
    : undefined
  const jsGap = landing.completeInitialClaim === 'exact' && nuxt.homeInitialClaim === 'structural-local'
    ? deltaSizes(report.totals['complete initial JS'], nuxt.homeInitialJs)
    : undefined
  const entryGap = nuxtEntry ? deltaSizes(report.appSizes, asSizes(nuxtEntry)) : undefined
  const firstPaintGap = extras.firstStartupClaim === 'exact' && nuxt.homeInitialClaim === 'structural-local'
    ? deltaSizes(extras.firstStartupJs, extras.nuxtJsPlusDefaultCatalog)
    : undefined
  const chrome = nuxt.files.find((item) => item.role === 'shared-app-chrome')
  const home = nuxt.files.find((item) => item.role === 'home-page')
  const deferred = nuxt.files.filter((item) => item.role === 'deferred-page')
  const localeTotal = nuxt.localeJson.reduce((total, item) => addSizes(total, item), emptySizes())
  const removedRendered = historical.entryAsymmetries['translations/en.json']
    + historical.entryAsymmetries['translations/ar.json']
    + historical.entryAsymmetries['@iconify/vue']
  const remainingFramework = report.appOwnership['vue-ssr-lite']
  const remainingVue = report.appOwnership.Vue + report.appOwnership['Vue Router']
  const historicalFramework = historical.appOwnership['vue-ssr-lite']
  return `# Task 013 — Like-for-Like Nuxt Benchmark & True Framework Overhead Measurement

Benchmark normalization and measurement only. No vue-ssr-lite runtime, capability, hydration, RouterView, middleware, SEO, fetch, chunk-naming, or public-API change was implemented.

Consumers:

1. \`/Users/safdar/Playground/nuxt-vue-ssr/landing\` — Vue 3 + Vite + vue-ssr-lite@${landing.installedPackage}
2. \`/Users/safdar/Playground/nuxt-vue-ssr/nuxt-landing\` — Nuxt equivalent (not modified in this task)

Workspace package version ${input.frameworkVersion}. Node ${input.node}.

## Metric contract

These families are never interchangeable:

| Family | What it measures | Encoder / source |
| --- | --- | --- |
| raw | Uncompressed file bytes | emitted JS or JSON bytes |
| gzip | Whole-file gzip | node zlib default |
| brotli | Whole-file Brotli | node zlib quality 11 |
| transferred / network | Bytes on the wire | browser/CDN \`Content-Encoding\` + transfer size |
| renderedLength | Pre-minifier module characters | Rollup module renderedLength |

Task 013 local **graphs** (same encoder family, different file sets):

| Graph | What is included | What it is not |
| --- | --- | --- |
| Client entry | The landing \`app.js\` file only | Not \`/\`, not locale data, not transferred |
| Entry + capability + rendered-route JS | Task 012 file set: entry-static + selected \`/\` capability files + SSR-manifest rendered-route JS | **Not** the complete JavaScript required to finish application install/hydration after Task 013 |
| First-startup JS | That Task 012 file set **plus** client files for entry-static \`import()\` targets the authoritative \`/\` render actually evaluated (install-awaited bootstrap JS) | Not Arabic locale-switch data; not transferred |
| First-startup JS/data vs Nuxt | Vue first-startup JS (includes the awaited locale **JS module**) vs Nuxt structural \`/\` JS + default English **JSON** | Not identical transport encoding |
| Later locale-switch-only data | Locale catalogs whose \`import()\` was **not** evaluated during the \`/\` render | Not first-startup |
| Historical transferred / network | Task 011 browser/CDN transfers | Never mixed with local gzip/Brotli |

Compressed bytes are never apportioned across mixed-owner files. The Task 012 file-set total is kept as an exact structural measurement. It is **not** renamed “complete-initial JS required by the page.”

## Historical references (do not mix with this audit)

### Task 011 transferred / network

- vue-ssr-lite app.js transferred: ${TASK_011_PRODUCTION_NETWORK_TRACE.appJs.bytes.toLocaleString()} B (\`content-encoding: ${TASK_011_PRODUCTION_NETWORK_TRACE.appJs.contentEncoding}\`)
- vue-ssr-lite complete initial JS transferred: ~${TASK_011_PRODUCTION_NETWORK_TRACE.completeInitialJs.bytes.toLocaleString()} B
- Nuxt initial JS transferred: ~${TASK_011_PRODUCTION_NETWORK_TRACE.nuxtInitialJs.bytes.toLocaleString()} B

These are **not** compared to the local gzip/Brotli numbers below.

### Task 012 local (pre-normalization)

${sizeLine('vue-ssr-lite app.js', historical.appJs)}
${sizeLine('vue-ssr-lite complete-initial `/`', historical.completeInitial)}
${sizeLine('Nuxt client entry (`' + historical.nuxt.entryFile + '`)', historical.nuxt.entry)}
${sizeLine('Nuxt structural `/` JS', historical.nuxt.structuralSlash)}

Task 012 \`app.js\` renderedLength ownership: Vue ${historical.appOwnership.Vue.toLocaleString()}; application ${historical.appOwnership['application code'].toLocaleString()}; Vue Router ${historical.appOwnership['Vue Router'].toLocaleString()}; vue-ssr-lite ${historical.appOwnership['vue-ssr-lite'].toLocaleString()}; third-party ${historical.appOwnership['third-party dependency'].toLocaleString()} (@iconify/vue only); unknown ${historical.appOwnership['unknown/unattributed'].toLocaleString()}.

Task 012 entry-static asymmetries (renderedLength): \`translations/en.json\` ${historical.entryAsymmetries['translations/en.json'].toLocaleString()}; \`translations/ar.json\` ${historical.entryAsymmetries['translations/ar.json'].toLocaleString()}; \`@iconify/vue\` ${historical.entryAsymmetries['@iconify/vue'].toLocaleString()}.

## 1. Before normalization

Task 012 proved the comparison was not architecture-equivalent:

- The Vue landing statically imported **both** \`translations/en.json\` and \`translations/ar.json\` from \`createI18n()\` in the application entry.
- The Vue landing globally registered \`Icon\` from \`main.ts\`, which made \`@iconify/vue\` entry-static.
- Nuxt uses the same \`@iconify/vue\` package, but Iconify lived on the shared Header/Footer/Icon chrome chunk, not the Nuxt client entry.
- Nuxt translation catalogs were HTTP JSON under \`.output/public/translations/\` and \`_locales/\`, not JS modules in the Nuxt entry.
- Home was already lazy in both implementations.
- \`vue-carousel-lite\` and \`v-tooltip-lite\` were required by the rendered \`/\` tree and must stay in the \`/\` JS file set.
- vue-ssr-lite was only **8.1%** of Task 012 \`app.js\` renderedLength (${historical.appOwnership['vue-ssr-lite'].toLocaleString()} of the entry). The total gap could not be attributed to the framework.

## 2. Exact normalization changes

Application-only. The Nuxt tree was not edited. vue-ssr-lite itself was not optimized.

1. **Translation loading (\`landing/src/i18n/index.ts\`)**
   - Removed static \`import en from '../../translations/en.json'\` and \`import ar from '../../translations/ar.json'\`.
   - Replaced them with Vite dynamic \`import()\` loaders keyed by locale.
   - \`createI18n\` is now \`async\`. It loads the **current** locale before first render, and also loads \`en\` when the current locale is \`ar\` (fallback).
   - \`$switchLocale\` still has TypeScript return type \`void\`. The observable locale / \`dir\` / \`localStorage\` change is **asynchronous**: the function starts a catalog loader, awaits it, then updates locale and document attributes. Callers do not receive a Promise. This task does not redesign that public API.
   - Locale resolution, hydration \`contribute('locale')\`, \`$t\` / \`$has\` fallback, and direction handling are unchanged.
   - No vue-ssr-lite locale API, i18n plugin, folder convention, or filename special-case was added to the framework.

2. **Iconify loading (\`landing/src/main.ts\` + landing Vite config)**
   - Removed \`import Icon from '@/components/Icon.vue'\` and \`app.component('Icon', Icon)\` from \`main.ts\`.
   - \`main.ts\` now only installs i18n: \`app.use(await createI18n({ hydration, server }))\`.
   - Added a landing-only Vite \`enforce: 'pre'\` plugin \`landing-icon-usage-import\`. It injects \`import Icon from '@/components/Icon.vue'\` into SFCs that already contain \`<Icon>\`, matching Nuxt component auto-import.
   - \`Icon.vue\` still imports \`{ Icon } from '@iconify/vue'\`. Icons were not removed or replaced.

3. **Unchanged on purpose**
   - Lazy routes in \`src/routes.ts\` (\`/\`, Solutions, Industries, Resources, Company, App details, redirects).
   - Home still imports Header, Footer, ContactForm, CookiesNotice, WhatsApp, and Home* sections.
   - \`vue-carousel-lite\` and \`v-tooltip-lite\` remain on the Home/Header tree.
   - No vue-ssr-lite capability, bootstrap, hydration, RouterView, middleware, SEO, fetch, chunk-naming, or \`manualChunks\` change.

Observed landing plugin \`landing-icon-usage-import\`: ${extras.observedIconPlugin ? 'yes' : '**no — Icon usage-site import plugin did not appear in the resolved production config**'}.

## 3. Why each change is required for fairness

1. **Translations.** Task 012's Vue entry retained both catalogs because they were static ESM imports. Nuxt does not embed those catalogs in its client entry. Measuring framework overhead while one side ships ~179k renderedLength of locale JSON in \`app.js\` is an application-loading asymmetry, not a framework result. Dynamic \`import()\` is a normal Vite consumer mechanism and keeps English / Arabic / SSR / hydration / fallback / direction behavior.

2. **Iconify.** Both apps already use \`@iconify/vue\` through the same \`Icon.vue\`. Nuxt auto-imports that component from pages/chrome. The Vue app previously forced the package into the bootstrap graph via a global register. Usage-site imports (or the equivalent compile-time auto-import) put Iconify on the same kind of page/chrome chunk Nuxt uses. Removing icons, or swapping the package, would not be a fair comparison.

3. **What was not changed.** Moving Home, carousel, tooltip, Header/Footer, or route CSS off \`/\` would hide real first-route work. Converting lazy ↔ eager routes would manipulate the graph. Framework changes would answer a different question than Task 013.

## 4. After normalization

- Entry translation modules: ${extras.locales.inEntry.length ? extras.locales.inEntry.join(', ') : 'none (catalogs are no longer entry-static)'}
- Translation modules inside the Task 012 file set: ${extras.locales.inCompleteInitial.length ? extras.locales.inCompleteInitial.join(', ') : 'none'}
- Install-awaited extra client files (evaluated entry-static \`import()\` targets not already in that file set): ${extras.installAwaited.files.map((file) => '`' + file + '`').join(', ') || '(none)'}
- First-startup claim: **${extras.firstStartupClaim}**
- Iconify in the Vue client entry: ${extras.iconify.inEntry ? '**yes — normalization failed**' : 'no'}
- Iconify files: ${extras.iconify.files.map((file) => '`' + file + '`').join(', ') || '(none)'}
- Iconify in the Task 012 \`/\` file set: ${extras.iconify.inCompleteInitial ? 'yes (required — Header/Home render Icon)' : '**no — unexpected; `/` still renders icons**'}
- \`vue-carousel-lite\` in the Task 012 \`/\` file set: ${extras.carousel.inCompleteInitial ? 'yes' : '**no — illegitimate removal**'} (${extras.carousel.renderedLength.toLocaleString()} renderedLength; ${extras.carousel.files.map((file) => '`' + file + '`').join(', ') || 'missing'})
- \`v-tooltip-lite\` in the Task 012 \`/\` file set: ${extras.tooltip.inCompleteInitial ? 'yes' : '**no — illegitimate removal**'} (${extras.tooltip.renderedLength.toLocaleString()} renderedLength; ${extras.tooltip.files.map((file) => '`' + file + '`').join(', ') || 'missing'})
- Application entry asymmetries normalized: ${extras.entryNormalized ? 'yes' : '**no**'}
- Legitimate \`/\` dependencies preserved: ${extras.legitimateRouteDepsPreserved ? 'yes' : '**no**'}
- Later locale-switch-only catalog files: ${extras.switchOnlyLocaleFiles.map((file) => '`' + file + '`').join(', ') || '(none)'}

## 5. vue-ssr-lite production graph

Installed vue-ssr-lite@${landing.installedPackage}. Production client build loaded landing \`vite.config.ts\`. Additive audit plugins only: \`${(landing.capabilityAccounting.additivePlugins ?? []).join('`, `') || '(none)'}\`.

- config file: \`${landing.observedConfig.configFile}\`
- minify: \`${String(landing.observedConfig.build.minify)}\`
- outDir: \`${landing.observedConfig.build.outDir}\`
- resolved plugins include \`landing-icon-usage-import\`: ${extras.observedIconPlugin ? 'yes' : 'no'}

${describeRequest(landing, extras)}

${sizeLine('client entry (' + report.appFile + ')', report.appSizes)}
${landing.completeInitialClaim === 'exact'
    ? sizeLine('entry + capability + rendered-route JS (Task 012 file set; not first-startup)', report.totals['complete initial JS'])
    : `- entry + capability + rendered-route JS: **not claimed**. ${landing.capabilityAccounting.claimReasons.join(' ')}`}
${extras.firstStartupClaim === 'exact'
    ? sizeLine('first-startup JS (Task 012 file set + install-awaited bootstrap JS)', extras.firstStartupJs)
    : `- first-startup JS: **not claimed**. Install-awaited dynamic imports were not reconciled (loaded ids ${landing.capabilityAccounting.request.kind === 'authoritative-render' ? landing.capabilityAccounting.request.loadedModuleIds.length : 0}; extra files ${extras.installAwaited.files.join(', ') || 'none'}; unmatched ${extras.installAwaited.unmatched.join(', ') || 'none'}).`}
${sizeLine('entry-static JS', report.totals['entry-static JS'])}
${landing.completeInitialClaim === 'exact' ? sizeLine('initial capability JS', report.totals['initial capability JS']) : '- initial capability JS: **not claimed**'}
${landing.completeInitialClaim === 'exact' ? sizeLine('route/application JS', report.totals['route/application JS']) : '- route/application JS: **not claimed**'}
${extras.firstStartupClaim === 'exact' ? sizeLine('install-awaited bootstrap JS (extra files only)', extras.installAwaitedJs) : '- install-awaited bootstrap JS: **not claimed**'}
${sizeLine('later/deferred JS (includes locale-switch-only catalogs and unused routes)', report.totals['later/deferred JS'])}
${bootstrapNote(extras)}

${landing.appCompression ? `Entry-file compression profiles for \`${report.appFile}\` (same bytes, different encoders; not transferred):
- raw: ${landing.appCompression.raw.bytes.toLocaleString()} B
- gzip (node default): ${landing.appCompression.gzipNodeDefault.bytes.toLocaleString()} B
- brotli quality 11: ${landing.appCompression.brotliNodeQuality11.bytes.toLocaleString()} B
- brotli quality 5: ${landing.appCompression.brotliNodeQuality5.bytes.toLocaleString()} B
` : ''}

| File | Role | Raw | Gzip | Brotli q11 | Dominant owner |
| --- | --- | ---: | ---: | ---: | --- |
${extras.fileRoles.map((chunk) => `| \`${chunk.file}\` | ${chunk.role} | ${chunk.bytes.toLocaleString()} | ${chunk.gzip.toLocaleString()} | ${chunk.brotli.toLocaleString()} | ${report.chunks.find((item) => item.file === chunk.file)?.owner ?? ''} |`).join('\n')}

- client entry: ${report.appFile}
- entry-static files: ${report.files.entryStatic.join(', ') || '(none)'}
- initial capability files: ${report.files.initialCapabilities.join(', ') || '(none)'}
- rendered-route files: ${report.files.renderedRoute.join(', ') || '(none)'}
- Task 012 file-set files: ${report.files.completeInitial.join(', ') || '(none)'}
- install-awaited extra files: ${extras.installAwaited.files.join(', ') || '(none)'}
- first-startup files: ${extras.firstStartupFiles.join(', ') || '(none)'}
- later locale-switch-only catalog files: ${extras.switchOnlyLocaleFiles.join(', ') || '(none)'}
- other deferred files: ${report.files.deferredOnly.filter((file) => !extras.installAwaited.files.includes(file) && !extras.switchOnlyLocaleFiles.includes(file)).join(', ') || '(none)'}

### \`app.js\` ownership (renderedLength)

${ownershipLines(report.appOwnership)}

Third-party packages inside \`${report.appFile}\`:
${report.appThirdParty.length ? report.appThirdParty.map((item) => `- ${item.name}: ${item.renderedLength.toLocaleString()}`).join('\n') : '- (none)'}

### Task 012 file-set ownership (renderedLength)

${ownershipLines(report.pageOwnership)}

### First-startup ownership (Task 012 file set + install-awaited extra files, renderedLength)

${extras.firstStartupClaim === 'exact' ? ownershipLines(extras.firstStartupOwnership) : '- first-startup ownership is **not claimed**.'}

### Largest retained modules in \`${report.appFile}\`

${retainedLines(report.topModules)}

### Largest retained modules in the Task 012 \`/\` file set

${retainedLines(report.completeInitialModules)}

### Static retention paths (Task 012 file set, first 25)

${pathLines(report.completeInitialModules)}

### Remaining vue-ssr-lite sources in the entry/static closure

${report.frameworkEntry.map((item) => `- \`${item.source}\` — ${item.classification} — ${item.renderedLength.toLocaleString()} renderedLength
  ${item.reason}`).join('\n') || '- (none)'}

## 6. Nuxt production graph

Nuxt was rebuilt for this audit and **not** source-normalized. Task 011 ~49.3 KB remains a transferred reference, not these local files.

${nuxt.buildError
    ? `- Nuxt production build did not complete: ${nuxt.buildError.split('\n')[0]}`
    : `- Nuxt production build completed. JS files under \`.output/public\`: ${nuxt.files.length}.`}

${nuxtEntry
    ? `- Nuxt client entry \`${nuxtEntry.file}\`: raw ${nuxtEntry.bytes.toLocaleString()} B · gzip ${nuxtEntry.gzip.toLocaleString()} B · brotli ${nuxtEntry.brotli.toLocaleString()} B
  ${nuxtEntry.evidence}
  Iconify in this file: ${nuxtEntry.containsIconify ? 'yes' : 'no'}. Translation path strings: ${nuxtEntry.containsTranslationPath ? 'yes' : 'no'}.`
    : '- No Nuxt client entry was identified.'}

${home
    ? `- Home page chunk \`${home.file}\`: raw ${home.bytes.toLocaleString()} B · gzip ${home.gzip.toLocaleString()} B · brotli ${home.brotli.toLocaleString()} B
  ${home.evidence}`
    : '- No Home page chunk was identified.'}

${chrome
    ? `- Shared app chrome \`${chrome.file}\`: raw ${chrome.bytes.toLocaleString()} B · gzip ${chrome.gzip.toLocaleString()} B · brotli ${chrome.brotli.toLocaleString()} B
  ${chrome.evidence}
  Iconify in this file: ${chrome.containsIconify ? 'yes' : 'no'}.`
    : '- No shared Header/Icon chrome chunk was identified.'}

${nuxt.homeInitialClaim === 'structural-local'
    ? `Structural local JS graph for Nuxt \`/\` (Home static relative imports + the Nuxt entry). **Not transferred** and **not** the Task 011 49.3 KB figure:
${sizeLine('sum of those whole files', nuxt.homeInitialJs)}
${nuxt.homeInitialFiles.map((item) => `- \`${item.file}\` (${item.role}): raw ${item.bytes.toLocaleString()} B · gzip ${item.gzip.toLocaleString()} B · brotli ${item.brotli.toLocaleString()} B`).join('\n')}`
    : '- Structural local JS graph for Nuxt `/` is **not claimed**.'}

Deferred page chunks:
${deferred.length ? deferred.map((item) => `- \`${item.file}\`: raw ${item.bytes.toLocaleString()} B`).join('\n') : '- (none)'}

Locale catalogs remain HTTP JSON:
${sizeLine('sum of published translation/_locales JSON', localeTotal)}
${nuxt.localeJson.map((item) => `- \`${item.file}\`: raw ${item.bytes.toLocaleString()} B · gzip ${item.gzip.toLocaleString()} B · brotli ${item.brotli.toLocaleString()} B`).join('\n') || '- (none)'}

JS files that contain \`/translations/\` or \`_locales/\` strings: ${extras.nuxtLocale.jsFilesWithTranslationStrings.join(', ') || '(none in classified JS; catalogs are still separate JSON)'}

English JSON artifacts used for the JS+data comparable family (not claimed as the only bytes Nuxt transfers):
${extras.nuxtLocale.publishedEnglish.map((item) => `- \`${item.file}\`: raw ${item.bytes.toLocaleString()} B · gzip ${item.gzip.toLocaleString()} B · brotli ${item.brotli.toLocaleString()} B`).join('\n') || '- (none)'}

## 7. Side-by-side local size comparison

Same metric family only: local raw / node gzip / node Brotli q11. Not Task 011 transferred bytes.

| Graph | vue-ssr-lite raw | vue-ssr-lite gzip | vue-ssr-lite br | Nuxt raw | Nuxt gzip | Nuxt br | Δ raw (lite − Nuxt) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Client entry | ${report.appSizes.bytes.toLocaleString()} | ${report.appSizes.gzip.toLocaleString()} | ${report.appSizes.brotli.toLocaleString()} | ${nuxtEntry ? nuxtEntry.bytes.toLocaleString() : '—'} | ${nuxtEntry ? nuxtEntry.gzip.toLocaleString() : '—'} | ${nuxtEntry ? nuxtEntry.brotli.toLocaleString() : '—'} | ${entryGap ? signed(entryGap.bytes) : '—'} |
| Structural \`/\` JS (entry + capability + rendered-route vs Nuxt Home graph) | ${landing.completeInitialClaim === 'exact' ? report.totals['complete initial JS'].bytes.toLocaleString() : 'not claimed'} | ${landing.completeInitialClaim === 'exact' ? report.totals['complete initial JS'].gzip.toLocaleString() : '—'} | ${landing.completeInitialClaim === 'exact' ? report.totals['complete initial JS'].brotli.toLocaleString() : '—'} | ${nuxt.homeInitialClaim === 'structural-local' ? nuxt.homeInitialJs.bytes.toLocaleString() : 'not claimed'} | ${nuxt.homeInitialClaim === 'structural-local' ? nuxt.homeInitialJs.gzip.toLocaleString() : '—'} | ${nuxt.homeInitialClaim === 'structural-local' ? nuxt.homeInitialJs.brotli.toLocaleString() : '—'} | ${jsGap ? signed(jsGap.bytes) : '—'} |
| First-startup JS/data (Vue install-awaited catalog JS + Nuxt default English JSON) | ${extras.firstStartupClaim === 'exact' ? extras.firstStartupJs.bytes.toLocaleString() : 'not claimed'} | ${extras.firstStartupClaim === 'exact' ? extras.firstStartupJs.gzip.toLocaleString() : '—'} | ${extras.firstStartupClaim === 'exact' ? extras.firstStartupJs.brotli.toLocaleString() : '—'} | ${nuxt.homeInitialClaim === 'structural-local' ? extras.nuxtJsPlusDefaultCatalog.bytes.toLocaleString() : 'not claimed'} | ${nuxt.homeInitialClaim === 'structural-local' ? extras.nuxtJsPlusDefaultCatalog.gzip.toLocaleString() : '—'} | ${nuxt.homeInitialClaim === 'structural-local' ? extras.nuxtJsPlusDefaultCatalog.brotli.toLocaleString() : '—'} | ${firstPaintGap && extras.firstStartupClaim === 'exact' ? signed(firstPaintGap.bytes) : '—'} |

The first-startup row is a **data-inclusive** comparison: Vue's awaited catalog is a JS module; Nuxt's default English catalog is HTTP JSON (\`translations/en.json\`). Those encodings are not identical and are **not** transferred/network bytes. This row is preserved as first-startup evidence, not as a claim that both sides ship the same artifact type. The structural \`/\` JS row above does **not** include that locale data.

## 8. Ownership comparison

### Task 012 \`app.js\` vs Task 013 \`app.js\` (renderedLength)

Task 012:
${ownershipLines(historical.appOwnership)}

Task 013:
${ownershipLines(report.appOwnership)}

Delta (013 − 012):
${ownershipDeltaLines(report.appOwnership, historical.appOwnership)}

### Task 012 complete-initial vs Task 013 complete-initial (renderedLength)

Task 012:
${ownershipLines(historical.completeInitialOwnership)}

Task 013:
${ownershipLines(report.pageOwnership)}

Delta (013 − 012):
${ownershipDeltaLines(report.pageOwnership, historical.completeInitialOwnership)}

Application-level bytes removed from the **entry asymmetry** (Task 012 renderedLength, not compressed bytes): ${removedRendered.toLocaleString()} (${historical.entryAsymmetries['translations/en.json'].toLocaleString()} English catalog + ${historical.entryAsymmetries['translations/ar.json'].toLocaleString()} Arabic catalog + ${historical.entryAsymmetries['@iconify/vue'].toLocaleString()} Iconify). Iconify is still charged to the Task 012 \`/\` file set when Header/Home render icons. The default English catalog is charged to **first-startup JS**, not to that structural file set. Arabic is later locale-switch-only unless the \`/\` render evaluated its \`import()\`.

## 9. Remaining framework/runtime gap

### A. How much did vue-ssr-lite \`app.js\` change?

${deltaLine('Task 013 app.js − Task 012 app.js', appDelta)}

This change is from **application** loading normalization, not from a vue-ssr-lite rewrite. vue-ssr-lite renderedLength in \`app.js\` moved ${signed(remainingFramework - historicalFramework)}.

### B. How much did the Task 012 \`/\` file set change?

${completeDelta
    ? deltaLine('Task 013 entry+capability+rendered-route JS − Task 012 complete-initial `/`', completeDelta)
    : '- The Task 012 file set is **not claimed** in this audit, so the delta is not claimed.'}

That Task 012 file set is still entry + \`/\` capability files + SSR-manifest route JS. After dynamic \`import()\`, **both** locale catalogs left it. That does **not** mean English left first-startup: \`createI18n()\` still \`await\`s the current catalog before install returns. English is in first-startup JS via the evaluated-module intersection, not via an \`en-*.js\` filename regex. Arabic stays later/switch-only when the \`/\` render does not evaluate its \`import()\`. Iconify moved from the entry onto the \`/\` chrome chunk and remains in the Task 012 file set. Home/carousel/tooltip stay. vue-ssr-lite renderedLength did not change.

${extras.firstStartupClaim === 'exact'
    ? sizeLine('Task 013 first-startup JS (do not compare this row to Task 012 complete-initial as if they were the same family)', extras.firstStartupJs)
    : '- Task 013 first-startup JS is **not claimed**.'}

### C. How much did Nuxt change?

${nuxtEntryDelta ? deltaLine('Nuxt entry − Task 012 Nuxt entry', nuxtEntryDelta) : '- Nuxt entry delta is unavailable.'}
${nuxtSlashDelta ? deltaLine('Nuxt structural `/` − Task 012 structural `/`', nuxtSlashDelta) : '- Nuxt structural `/` delta is unavailable.'}

Nuxt source was not normalized. Residual hash/byte movement is rebuild noise, not a Task 013 application change.

### D. What application-level bytes were removed from the comparison asymmetry?

- From the Vue **entry**: both locale catalogs and \`@iconify/vue\` are no longer entry-static (Task 012 renderedLength ${removedRendered.toLocaleString()}).
- Whole-file \`app.js\` raw change: ${signed(appDelta.bytes)} B.
- From the Task 012 file set: ${completeDelta ? `${signed(completeDelta.bytes)} B raw. That drop is locale **data** leaving the structural JS set (English is now install-awaited extra JS; Arabic is switch-only), plus chunk-boundary/compression effects — not a vue-ssr-lite shrink. Iconify remaining on \`/\` is not an asymmetry. First-startup JS still includes the awaited English catalog.` : 'not claimed.'}

### E. What remains different?

${jsGap
    ? `On the **structural \`/\` JS** family (no locale data), vue-ssr-lite entry+capability+rendered-route JS is ${signed(jsGap.bytes)} B raw / ${signed(jsGap.gzip)} B gzip / ${signed(jsGap.brotli)} B Brotli versus Nuxt's structural \`/\` JS.
On **first-startup JS/data**, ${extras.firstStartupClaim === 'exact' && firstPaintGap ? `vue-ssr-lite is ${signed(firstPaintGap.bytes)} B raw / ${signed(firstPaintGap.gzip)} B gzip / ${signed(firstPaintGap.brotli)} B Brotli versus Nuxt structural \`/\` JS + \`translations/en.json\`.` : 'the Vue side is not claimed.'}
On **client entries** alone, vue-ssr-lite \`app.js\` is ${entryGap ? `${signed(entryGap.bytes)} B raw / ${signed(entryGap.gzip)} B gzip / ${signed(entryGap.brotli)} B Brotli` : 'uncompared'} versus the Nuxt entry.`
    : 'A like-for-like `/` JS gap is not claimed because one side lacks an exact/structural graph.'}

Remaining structural differences that are **not** the Task 012 application asymmetries:

- Different framework client runtimes (vue-ssr-lite hydration/capability hosts vs Nuxt \`nuxt-root\` / unhead / payload wiring).
- Vue and Vue Router packaging: vue-ssr-lite entry still contains Vue + Vue Router as identifiable modules; Nuxt's entry also contains Vue, but this audit does not split Nuxt files by renderedLength owner.
- Route/application code still required by \`/\` (Home, Header/Footer, ContactForm, CookiesNotice, carousel, tooltip, Iconify).
- Locale **transport**: Vue emits locale JS chunks; Nuxt publishes locale JSON. Those are equivalent loading semantics, not identical encodings.
- Chunk boundaries (one Vue Home file vs Nuxt Home + chrome + NuxtLink + helper).

### F. Of the remaining difference, what can be attributed?

Do **not** attribute the entire remaining JS gap to vue-ssr-lite unless the entry/complete-initial ownership proves it.

- **vue-ssr-lite:** ${remainingFramework.toLocaleString()} renderedLength in the normalized \`app.js\` (${percent(remainingFramework, sum(Object.values(report.appOwnership)))} of that file). Task 012 file-set vue-ssr-lite: ${report.pageOwnership['vue-ssr-lite'].toLocaleString()} renderedLength. First-startup vue-ssr-lite is the same unless an install-awaited extra file is framework-owned (it is not). Task 012 already showed the framework was a minority of the pre-normalization entry; that remains true.
- **Nuxt runtime:** The Nuxt entry (${nuxtEntry ? `${nuxtEntry.bytes.toLocaleString()} B raw` : 'unidentified'}) is Nuxt's client runtime plus Vue shared. This audit does not have Nuxt-module renderedLength ownership, so Nuxt runtime vs Vue-inside-Nuxt is **not** split. Treating the whole Nuxt entry as "Nuxt framework" would over-attribute Nuxt the same way treating the whole Vue \`app.js\` as vue-ssr-lite would over-attribute vue-ssr-lite.
- **Vue / Vue Router packaging:** Normalized \`app.js\` still holds Vue ${report.appOwnership.Vue.toLocaleString()} + Vue Router ${report.appOwnership['Vue Router'].toLocaleString()} renderedLength (${remainingVue.toLocaleString()} combined). That pair is larger than vue-ssr-lite itself. Nuxt also ships Vue; the leftover entry gap after removing catalogs/Iconify is mostly this packaging plus each framework's host, not vue-ssr-lite application code.
- **Unavoidable route/application code:** Home/chrome/carousel/tooltip/Iconify/ContactForm remain on both \`/\` graphs. Those bytes are application/third-party, not framework overhead.
- **Unresolved / unknown:** ${report.appOwnership['unknown/unattributed'].toLocaleString()} renderedLength in \`app.js\`; Nuxt files without a role; encoder differences between JS-wrapped locale chunks and HTTP JSON; any Nuxt first-paint JSON beyond \`translations/en.json\`; transferred-vs-local compression.

${finalAnswer(jsGap, firstPaintGap, entryGap, remainingFramework, remainingVue, extras, report)}

## 10. What Task 014 should investigate

Do not start Task 014 from this file as an implementation ticket. Evidence-only follow-ups:

1. **Vue / Vue Router packaging vs Nuxt's Vue share.** Split the Nuxt entry with the same renderedLength method used here, or compare a Vue-external build of both apps.
2. **Host runtime overlap.** Map vue-ssr-lite entry hosts (\`SsrBrowserRuntime\`, \`RouterView\`, hydration adapter, SEO state stubs) onto Nuxt \`nuxt-root\` / unhead / payload / island code. That is the true framework-vs-framework remainder.
3. **Like-for-like transferred measurement** of *these* normalized artifacts. Do not reuse Task 011 118,771 / ~163,900 / ~49,300 as if they were this build.
4. **Locale transport.** JS-module catalogs vs \`nuxt-i18n-micro\` JSON/\`_locales\` fetch. Decide whether first-paint should charge JS+JSON together.
5. **Capability modulepreloads.** Only if a later task asks whether vue-ssr-lite hosts can move without changing Task 011 boundaries. Task 013 forbids that work.
6. Do **not** remove carousel, tooltip, Home, Header/Footer, or icons to chase the leftover gap.

## 11. Explicit limitations

- Local node-zlib gzip/Brotli is **not** browser/CDN transferred Brotli. Task 011 network numbers stay in their own family.
- The Task 012 file-set claim is exact only when the Task 012 rules still hold (authoritative \`/\` render, SSR manifest reconciliation, selected files present, no external URLs). That claim is **not** first-startup JS.
- First-startup JS is claimed only when that file set is exact **and** every evaluated entry-static \`import()\` target maps to an emitted client file. Identification uses the \`/\` render module graph, not an \`en-*.js\` filename regex.
- Nuxt \`/\` JS is a **structural-local** import graph, not an SSR-manifest claim of the same kind as the Vue Task 012 file set.
- renderedLength is not a share of gzip/Brotli.
- Locale JS chunks and locale JSON files are equivalent *loading* behavior, not identical byte encodings.
- The Icon usage-site plugin is a landing Vite compile-time auto-import, not a vue-ssr-lite API. It is the consumer equivalent of Nuxt component auto-import.
- This audit builds the landing client graph through the landing Vite config plus observe/audit plugins only. It does not alias vue-ssr-lite back to repository source.
- English \`/\` is the measured route. Arabic first-paint would also load the English fallback catalog.
- No browser transferred capture of the normalized build is claimed here.
- Nuxt may publish more locale JSON than one first-paint request uses. Only files with evidence are discussed as data; the rest remain published artifacts.
- Task 012 historical numbers above are copied, not re-measured.
- The audit \`/\` render loader previously used only Vue+Tailwind. Task 013 loads landing \`vite.config.ts\` plugins except \`vue-ssr-lite\`, so application Icon auto-import applies during the authoritative render. That does not change the production client graph.
- The install-awaited English catalog is application data required before install/hydration completes. Hiding it from first-startup would be incorrect; calling the Task 012 file-set total the complete JS required by the page would also be incorrect; charging that catalog as vue-ssr-lite framework JS would also be incorrect.

## STATUS

${statusLines(landing, extras, jsGap)}
`
}

const percent = (part: number, total: number) => total ? `${((part / total) * 100).toFixed(1)}%` : '0.0%'

const bootstrapNote = (extras: ReturnType<typeof analyzeLikeForLikeExtras>) =>
  `- Install-awaited extra JS files: ${extras.installAwaited.files.join(', ') || '(none)'}${extras.installAwaited.files.length ? `\n${sizeLine('those extra files', extras.installAwaitedJs)}` : ''}
- Evaluated entry-static \`import()\` source modules: ${extras.installAwaited.awaitedModuleIds.join(', ') || '(none)'}
- Later locale-switch-only catalog files: ${extras.switchOnlyLocaleFiles.join(', ') || '(none)'}

These extra files are identified by intersecting the authoritative \`/\` render's evaluated Vite modules with dynamic-import targets of the entry-static closure, then mapping those source ids onto emitted client chunks. Hashed locale filenames are not the accounting key.`

const finalAnswer = (
  jsGap: Sizes | undefined,
  firstPaintGap: Sizes | undefined,
  entryGap: Sizes | undefined,
  framework: number,
  vuePair: number,
  extras: ReturnType<typeof analyzeLikeForLikeExtras>,
  report: LandingAudit['report'],
) => {
  if (!extras.entryNormalized || !jsGap) {
    return `### Final conclusions

This audit **cannot** close the comparison because ${!extras.entryNormalized ? 'the Vue entry still retains locale catalogs or Iconify' : 'the structural `/` JS comparison is not claimed'}.`
  }
  const structural = jsGap.bytes === 0
    ? 'the same size as'
    : jsGap.bytes > 0
      ? `${jsGap.bytes.toLocaleString()} B raw larger than`
      : `${Math.abs(jsGap.bytes).toLocaleString()} B raw smaller than`
  const startup = !firstPaintGap
    ? '**not claimed** (install-awaited extras were not reconciled).'
    : firstPaintGap.bytes === 0
      ? 'the same size as Nuxt structural `/` JS + default English JSON.'
      : firstPaintGap.bytes > 0
        ? `${firstPaintGap.bytes.toLocaleString()} B raw larger than Nuxt structural \`/\` JS + default English JSON (gzip ${signed(firstPaintGap.gzip)} B, Brotli q11 ${signed(firstPaintGap.brotli)} B).`
        : `${Math.abs(firstPaintGap.bytes).toLocaleString()} B raw smaller than Nuxt structural \`/\` JS + default English JSON (gzip ${signed(firstPaintGap.gzip)} B, Brotli q11 ${signed(firstPaintGap.brotli)} B).`
  return `### Final conclusions

**A. Structural \`/\` JS graph.** vue-ssr-lite entry+capability+rendered-route JS is **${structural}** the Nuxt structural \`/\` JS (gzip ${signed(jsGap.gzip)} B, Brotli q11 ${signed(jsGap.brotli)} B). This row excludes locale data on both sides. It is **not** the complete JavaScript required to finish Vue install/hydration.

**B. First-startup with default English locale data.** vue-ssr-lite is ${startup} Vue's extra bytes here are an awaited **JS module**; Nuxt's added bytes are **HTTP JSON**. Same first-startup *role*, not the same encoding, and not Task 011 transferred bytes. Client-entry-only gap: ${entryGap ? `${signed(entryGap.bytes)} B raw` : 'unavailable'}.

**C. Framework-owned versus other owners.** vue-ssr-lite renderedLength did **not** change (entry ${framework.toLocaleString()}, Task 012 file set ${report.pageOwnership['vue-ssr-lite'].toLocaleString()}). Normalized \`app.js\` is Vue ${report.appOwnership.Vue.toLocaleString()} + Vue Router ${report.appOwnership['Vue Router'].toLocaleString()} (${vuePair.toLocaleString()} combined) + vue-ssr-lite ${framework.toLocaleString()} + application ${report.appOwnership['application code'].toLocaleString()}. The install-awaited catalog extra is application data. Iconify/carousel/tooltip/Home/chrome remain third-party or application on both \`/\` graphs. The Nuxt entry is an unsplit Vue+Nuxt file. The remaining structural gap is therefore **not** proven to be vue-ssr-lite versus Nuxt runtime alone.

**D. Optimization task.** Current evidence does **not** justify opening a vue-ssr-lite optimization task. The framework host did not shrink or grow in this normalization; the leftover difference is Vue/Vue Router packaging, unsplit Nuxt runtime, route-owned application/third-party code, and locale transport encoding. Task 014 is **not** opened.`
}

const statusLines = (
  landing: LandingAudit,
  extras: ReturnType<typeof analyzeLikeForLikeExtras>,
  jsGap: Sizes | undefined,
) => {
  const failures = [
    extras.entryNormalized ? undefined : 'Vue entry still retains locale catalogs or @iconify/vue.',
    extras.legitimateRouteDepsPreserved ? undefined : 'vue-carousel-lite or v-tooltip-lite left the Task 012 `/` file set.',
    extras.iconify.inCompleteInitial ? undefined : 'Iconify is missing from the Task 012 `/` file set even though `/` renders icons.',
    extras.observedIconPlugin ? undefined : 'landing-icon-usage-import was not in the resolved Vite plugin list.',
    landing.completeInitialClaim === 'exact' ? undefined : 'entry + capability + rendered-route JS is not claimed as exact.',
    extras.firstStartupClaim === 'exact' ? undefined : 'first-startup JS (Task 012 file set + install-awaited extras) is not claimed.',
    jsGap ? undefined : 'A like-for-like structural `/` JS gap could not be computed.',
  ].filter((item): item is string => Boolean(item))
  if (failures.length) {
    return `Task 013 is **incomplete**:
${failures.map((item) => `- ${item}`).join('\n')}`
  }
  return `Task 013 methodology is complete: application-level translation and Iconify loading were normalized without changing vue-ssr-lite; the Task 012 file set remains exact and is no longer described as the complete JS required by the page; first-startup JS includes install-awaited bootstrap dynamic imports from the \`/\` render graph; Nuxt was re-inspected with the Task 012 classifier; historical Task 011/012 numbers remain separate; remaining differences are not attributed entirely to vue-ssr-lite.

Task 014 is **not** opened.`
}

export const runTask013LikeForLikeBenchmark = async (options: {
  frameworkRoot: string
  landingRoot: string
  nuxtRoot: string
  reportRoot: string
}) => {
  await mkdir(options.reportRoot, { recursive: true })
  await execFileAsync('yarn', ['merge:i18n'], {
    cwd: options.landingRoot,
    timeout: 60_000,
  })
  const frameworkVersion = JSON.parse(await readFile(join(options.frameworkRoot, 'package.json'), 'utf8')).version as string
  const landing = await buildLandingProductionAudit({
    frameworkRoot: options.frameworkRoot,
    landingRoot: options.landingRoot,
  })
  const nuxt = await inspectNuxtLandingProduction(options.nuxtRoot)
  const extras = analyzeLikeForLikeExtras(landing, nuxt)
  const payload = {
    version: 1,
    note: 'Task 013 like-for-like local audit. Task 012 historical numbers are constants. Task 011 figures are transferred-only.',
    node: process.version,
    frameworkVersion,
    installedLandingPackage: landing.installedPackage,
    completeInitialClaim: landing.completeInitialClaim,
    historical: {
      task011: TASK_011_PRODUCTION_NETWORK_TRACE,
      task012: TASK_012_HISTORICAL_LOCAL,
    },
    observedConfig: landing.observedConfig,
    capabilityAccounting: landing.capabilityAccounting,
    appCompression: landing.appCompression,
    landing: landing.report,
    extras,
    nuxt: {
      buildError: nuxt.buildError,
      files: nuxt.files,
      entryFiles: nuxt.entryFiles,
      homeInitialFiles: nuxt.homeInitialFiles,
      homeInitialJs: nuxt.homeInitialJs,
      homeInitialClaim: nuxt.homeInitialClaim,
      localeJson: nuxt.localeJson,
      totalJs: nuxt.totalJs,
    },
  }
  await writeFile(join(options.reportRoot, 'task-013-like-for-like.json'), JSON.stringify(payload, null, 2))
  const markdown = renderLikeForLikeMarkdown({
    landing,
    nuxt,
    extras,
    frameworkVersion,
    node: process.version,
  })
  const markdownPath = join(options.reportRoot, 'TASK-013-LIKE-FOR-LIKE-BENCHMARK.md')
  await writeFile(markdownPath, markdown)
  return {
    markdownPath,
    reportRoot: options.reportRoot,
    landing: landing.report,
    extras,
    completeInitialClaim: landing.completeInitialClaim,
    capabilityAccounting: landing.capabilityAccounting,
  }
}
