import { createSsrFrameworkSourceResolver, frameworkModuleSources } from '../../src/assets/SsrModuleAttribution'
import { createSsrBootstrapAssetManifest, type SsrBootstrapBuildApplication } from '../../src/vite/SsrViteBootstrap'
export { frameworkModuleSources } from '../../src/assets/SsrModuleAttribution'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import type { OutputAsset, OutputBundle, Plugin } from 'rollup'

export type BundleOwner = 'vue' | 'vue-router' | 'framework-core' | 'framework-fetch' |
  'framework-seo' | 'framework-middleware' | 'framework-navigation' |
  'framework-extensions' | 'framework-reactivity' |
  'application' | 'third-party' | 'bundler'

const normalize = (id: string) => id.replaceAll('\\', '/')

export const normalizeFrameworkRoot = (root: string) =>
  root.replaceAll('\\', '/').replace(/\/+$/, '')

export const bundleModuleOwner = (id: string, frameworkRoot: string): BundleOwner => {
  const path = normalize(id)
  const root = normalizeFrameworkRoot(frameworkRoot)
  const framework = path.startsWith(`${root}/src/`) || path.startsWith(`${root}/dist/`) ||
    /\/node_modules\/vue-ssr-lite\//.test(path)
  if (framework) {
    if (/SsrFetchRuntimeScope|ExtensionRuntimeKey|SsrNavigationContext/.test(path)) return 'framework-core'
    if (/SsrReactivityRuntime/.test(path)) return 'framework-reactivity'
    if (/\/extensions\/core\//.test(path)) return 'framework-extensions'
    if (/\/data\/fetch\/|SsrFetch/.test(path)) return 'framework-fetch'
    if (/\/extensions\/seo\//.test(path)) return 'framework-seo'
    if (/SsrBrowserMiddleware|SsrMiddlewarePresence/.test(path)) return 'framework-core'
    if (/\/middleware\/|SsrMiddleware/.test(path)) return 'framework-middleware'
    if (/\/navigation\/|SsrNavigation/.test(path)) return 'framework-navigation'
    return 'framework-core'
  }
  if (/\/node_modules\/vue\//.test(path) ||
    /\/node_modules\/@vue\/(?:runtime-core|runtime-dom|reactivity|shared|compiler-sfc|compiler-core|compiler-dom|compiler-ssr|server-renderer)\//.test(path)) {
    return 'vue'
  }
  if (/\/node_modules\/vue-router\//.test(path)) return 'vue-router'
  if (path.includes('/node_modules/')) return 'third-party'
  if (path.startsWith('\0') || path.startsWith('vite/')) return 'bundler'
  return 'application'
}

const sizes = (source: string | Uint8Array) => ({
  bytes: typeof source === 'string' ? Buffer.byteLength(source) : source.byteLength,
  gzip: gzipSync(source).byteLength,
  brotli: brotliCompressSync(source).byteLength,
})

const sumSizes = (values: readonly ReturnType<typeof sizes>[]) => values.reduce((total, value) => ({
  bytes: total.bytes + value.bytes,
  gzip: total.gzip + value.gzip,
  brotli: total.brotli + value.brotli,
}), { bytes: 0, gzip: 0, brotli: 0 })

/**
 * Test/build inspection only: never imported by a production entry and never
 * emitted into public assets. Rollup renderedLength attributes pre-minifier
 * characters, NOT compressed bytes. Compression is meaningful per whole file.
 */
export interface BundleAuditOptions {
  /** Emitted by the library build; maps dist files to original implementation ids. */
  moduleSources?: Record<string, string[]>
  /** Task 010 resolver for source, workspace-linked, and installed package ids. */
  resolveSources?: (id: string) => readonly string[]
  moduleInfo?: (id: string) => { importedIds: readonly string[]; dynamicallyImportedIds: readonly string[] } | null
}

export const inspectSsrBundle = (bundle: OutputBundle, frameworkRoot: string, options: BundleAuditOptions = {}) => {
  const root = normalizeFrameworkRoot(frameworkRoot)
  const sourcesFor = (id: string) => {
    const resolved = options.resolveSources?.(id)
    return resolved?.length ? resolved : frameworkModuleSources(id, root, options)
  }
  const chunks = Object.values(bundle).filter((item) => item.type === 'chunk').map((chunk) => ({
    file: chunk.fileName,
    entry: chunk.isEntry,
    facadeModuleId: chunk.facadeModuleId,
    imports: chunk.imports,
    dynamicImports: chunk.dynamicImports,
    css: [...((chunk as typeof chunk & { viteMetadata?: { importedCss?: Set<string> } }).viteMetadata?.importedCss ?? [])],
    sizes: sizes(chunk.code),
    modules: Object.entries(chunk.modules).map(([id, module]) => ({
      id,
      sources: sourcesFor(id),
      owner: bundleModuleOwner(
        sourcesFor(id).length === 1
          ? `${root}/src/${sourcesFor(id)[0]}` : id,
        root
      ),
      imports: [...(options.moduleInfo?.(id)?.importedIds ?? [])],
      dynamicImports: [...(options.moduleInfo?.(id)?.dynamicallyImportedIds ?? [])],
      dynamicImportSources: (options.moduleInfo?.(id)?.dynamicallyImportedIds ?? [])
        .flatMap((target) => [...sourcesFor(target)]),
      renderedLength: module.renderedLength,
      originalLength: module.originalLength,
      renderedExports: module.renderedExports,
    })),
  }))
  const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]))
  const stylesheets = Object.values(bundle)
    .filter((item): item is OutputAsset => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) => ({ file: item.fileName, sizes: sizes(item.source) }))
  const cssByFile = new Map(stylesheets.map((asset) => [asset.file, asset]))
  // A rendered lazy chunk can be passed as a seed; never walk dynamicImports.
  // Explicit CSS seeds cover SSR-manifest relationships not attached to a JS chunk.
  const critical = (seeds: readonly string[], stylesheetSeeds: readonly string[] = [], selection: { exact?: boolean; css?: boolean } = {}) => {
    const files = new Set<string>()
    const external = new Set<string>()
    const visit = (file: string) => {
      if (files.has(file) || external.has(file)) return
      const chunk = byFile.get(file)
      if (!chunk) { external.add(file); return }
      files.add(file)
      if (!selection.exact) chunk.imports.forEach(visit)
    }
    seeds.forEach(visit)
    const selected = [...files].map((file) => byFile.get(file)!)
    const ownership: Partial<Record<BundleOwner, number>> = {}
    for (const chunk of selected) for (const module of chunk.modules) {
      ownership[module.owner] = (ownership[module.owner] ?? 0) + module.renderedLength
    }
    const css = [...new Set([...(selection.css === false ? [] : selected.flatMap((chunk) => chunk.css)), ...stylesheetSeeds])]
    const unresolvedCss = css.filter((file) => !cssByFile.has(file))
    const js = sumSizes(selected.map((chunk) => chunk.sizes))
    const cssSizes = sumSizes(css.flatMap((file) => cssByFile.has(file) ? [cssByFile.get(file)!.sizes] : []))
    return {
      files: [...files], external: [...external], css, unresolvedCss,
      js, cssSizes, total: sumSizes([js, cssSizes]),
      resourceCount: files.size + external.size + css.length,
      // Compression across mixed-owner files cannot be allocated exactly.
      renderedLengthByOwner: ownership,
      frameworkSources: [...new Set(selected.flatMap((chunk) => chunk.modules)
        .filter((module) => module.owner.startsWith('framework-') && module.renderedLength > 0)
        .flatMap((module) => module.sources))].sort(),
      applicationSources: [...new Set(selected.flatMap((chunk) => chunk.modules)
        .filter((module) => module.owner === 'application' && module.renderedLength > 0)
        .map((module) => module.id))].sort(),
      frameworkModules: [...new Set(selected.flatMap((chunk) => chunk.modules)
        .filter((module) => module.owner.startsWith('framework-') && module.renderedLength > 0)
        .map((module) => module.id))],
    }
  }
  const bootstrapReport = (entryFiles: readonly string[], capabilityFiles: readonly string[], routeFiles: readonly string[], routeCss: readonly string[] = []) => {
    const entryStatic = critical(entryFiles)
    const initial = critical(capabilityFiles)
    const rendered = critical(routeFiles, routeCss)
    const required = new Set([...entryStatic.files, ...initial.files, ...rendered.files])
    const initialCapabilities = critical([...initial.files.filter((file) => !entryStatic.files.includes(file)), ...initial.external.filter((file) => !entryStatic.external.includes(file))], initial.css.filter((file) => !entryStatic.css.includes(file)), { exact: true, css: false })
    const renderedRoute = critical([...rendered.files.filter((file) => !entryStatic.files.includes(file) && !initialCapabilities.files.includes(file)), ...rendered.external.filter((file) => !entryStatic.external.includes(file) && !initialCapabilities.external.includes(file))],
      rendered.css.filter((file) => !entryStatic.css.includes(file) && !initialCapabilities.css.includes(file)), { exact: true, css: false })
    const completeInitialPage = critical([...required, ...new Set([...entryStatic.external, ...initial.external, ...rendered.external])], [...entryStatic.css, ...initial.css, ...rendered.css], { exact: true })
    const deferredOnly = critical(chunks.map((chunk) => chunk.file).filter((file) => !required.has(file)),
      stylesheets.map((style) => style.file).filter((file) => !completeInitialPage.css.includes(file)), { exact: true, css: false })
    // Module edges explain static retention; chunk co-location is reported when
    // manual chunking retains a module without a static source import path.
    const paths = new Map<string, string[]>()
    const queue: string[] = []
    for (const file of entryFiles) {
      const id = byFile.get(file)?.facadeModuleId
      if (id) { paths.set(id, [id]); queue.push(id) }
    }
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!
      for (const dependency of options.moduleInfo?.(id)?.importedIds ?? []) {
        if (paths.has(dependency)) continue
        paths.set(dependency, [...paths.get(id)!, dependency])
        queue.push(dependency)
      }
    }
    const staticRetention = chunks.filter((chunk) => entryStatic.files.includes(chunk.file)).flatMap((chunk) =>
      chunk.modules.filter((module) => module.renderedLength > 0 && module.owner.startsWith('framework-')).flatMap((module) =>
        module.sources.map((source) => ({ source, file: chunk.file, moduleId: module.id,
          renderedLength: module.renderedLength, path: paths.get(module.id) ?? [],
          reason: paths.has(module.id) ? 'static-import-path' : 'emitted-static-chunk',
        }))
      )
    ).sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1 : 0)
    return { entryStatic, initialCapabilities, renderedRoute, completeInitialPage, deferredOnly, staticRetention }
  }
  return {
    chunks,
    stylesheets,
    bootstrapReport,
    bootstrapManifest: (applications: readonly SsrBootstrapBuildApplication[]) =>
      createSsrBootstrapAssetManifest(bundle, applications, sourcesFor),
    entries: chunks.filter((chunk) => chunk.entry).map((chunk) => ({ file: chunk.file, ...critical([chunk.file]) })),
    critical,
  }
}

/** Observe a user's normal build without overriding output/chunking settings. */
export const ssrBundleAudit = (
  frameworkRoot: string,
  receive: (audit: ReturnType<typeof inspectSsrBundle>) => void,
  options: BundleAuditOptions = {}
): Plugin => ({
  name: 'vue-ssr-lite:test-bundle-audit',
  async generateBundle(_options, bundle) {
    const root = normalizeFrameworkRoot(frameworkRoot)
    const ids = Object.values(bundle).flatMap((output) => output.type === 'chunk' ? Object.keys(output.modules) : [])
    const discovered = options.resolveSources ?? await createSsrFrameworkSourceResolver(ids)
    receive(inspectSsrBundle(bundle, root, {
      ...options,
      resolveSources: (id) => {
        const resolved = discovered(id)
        return resolved.length ? resolved : frameworkModuleSources(id, root, options)
      },
      moduleInfo: (id) => this.getModuleInfo(id),
    }))
  },
})
