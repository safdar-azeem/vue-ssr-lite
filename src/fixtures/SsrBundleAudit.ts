import { brotliCompressSync, gzipSync } from 'node:zlib'
import type { OutputAsset, OutputBundle, Plugin } from 'rollup'

export type BundleOwner = 'vue' | 'vue-router' | 'framework-core' | 'framework-fetch' |
  'framework-seo' | 'framework-middleware' | 'framework-navigation' |
  'application' | 'third-party' | 'bundler'

const normalize = (id: string) => id.replaceAll('\\', '/')

export const bundleModuleOwner = (id: string, frameworkRoot: string): BundleOwner => {
  const path = normalize(id)
  const root = normalize(frameworkRoot).replace(/\/$/, '')
  const framework = path.startsWith(`${root}/src/`) || path.startsWith(`${root}/dist/`) ||
    /\/node_modules\/vue-ssr-lite\//.test(path)
  if (framework) {
    if (/\/data\/fetch\/|SsrFetch/.test(path)) return 'framework-fetch'
    if (/\/extensions\/seo\//.test(path)) return 'framework-seo'
    if (/\/middleware\/|SsrMiddleware/.test(path)) return 'framework-middleware'
    if (/\/navigation\/|SsrNavigation/.test(path)) return 'framework-navigation'
    return 'framework-core'
  }
  if (/\/node_modules\/(?:@vue\/|vue\/)/.test(path)) return 'vue'
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
export const inspectSsrBundle = (bundle: OutputBundle, frameworkRoot: string) => {
  const chunks = Object.values(bundle).filter((item) => item.type === 'chunk').map((chunk) => ({
    file: chunk.fileName,
    entry: chunk.isEntry,
    imports: chunk.imports,
    dynamicImports: chunk.dynamicImports,
    css: [...((chunk as typeof chunk & { viteMetadata?: { importedCss?: Set<string> } }).viteMetadata?.importedCss ?? [])],
    sizes: sizes(chunk.code),
    modules: Object.entries(chunk.modules).map(([id, module]) => ({
      id,
      owner: bundleModuleOwner(id, frameworkRoot),
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
  const critical = (seeds: readonly string[], stylesheetSeeds: readonly string[] = []) => {
    const files = new Set<string>()
    const external = new Set<string>()
    const visit = (file: string) => {
      if (files.has(file) || external.has(file)) return
      const chunk = byFile.get(file)
      if (!chunk) { external.add(file); return }
      files.add(file)
      chunk.imports.forEach(visit)
    }
    seeds.forEach(visit)
    const selected = [...files].map((file) => byFile.get(file)!)
    const ownership: Partial<Record<BundleOwner, number>> = {}
    for (const chunk of selected) for (const module of chunk.modules) {
      ownership[module.owner] = (ownership[module.owner] ?? 0) + module.renderedLength
    }
    const css = [...new Set([...selected.flatMap((chunk) => chunk.css), ...stylesheetSeeds])]
    const unresolvedCss = css.filter((file) => !cssByFile.has(file))
    const js = sumSizes(selected.map((chunk) => chunk.sizes))
    const cssSizes = sumSizes(css.flatMap((file) => cssByFile.has(file) ? [cssByFile.get(file)!.sizes] : []))
    return {
      files: [...files], external: [...external], css, unresolvedCss,
      js, cssSizes, total: sumSizes([js, cssSizes]),
      resourceCount: files.size + external.size + css.length,
      // Compression across mixed-owner files cannot be allocated exactly.
      renderedLengthByOwner: ownership,
      frameworkModules: [...new Set(selected.flatMap((chunk) => chunk.modules)
        .filter((module) => module.owner.startsWith('framework-') && module.renderedLength > 0)
        .map((module) => module.id))],
    }
  }
  return {
    chunks,
    stylesheets,
    entries: chunks.filter((chunk) => chunk.entry).map((chunk) => ({ file: chunk.file, ...critical([chunk.file]) })),
    critical,
  }
}

/** Observe a user's normal build without overriding output/chunking settings. */
export const ssrBundleAudit = (
  frameworkRoot: string,
  receive: (audit: ReturnType<typeof inspectSsrBundle>) => void
): Plugin => ({
  name: 'vue-ssr-lite:test-bundle-audit',
  generateBundle(_options, bundle) { receive(inspectSsrBundle(bundle, frameworkRoot)) },
})
