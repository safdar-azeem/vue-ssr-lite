import type { SsrRenderedApplicationAsset } from './SsrApplicationAssetRuntime'

export type SsrViteManifest = Readonly<Record<string, readonly string[]>>

const JAVASCRIPT_ASSET_RE = /\.(?:js|mjs)(?:$|[?#])/i
const STYLESHEET_ASSET_RE = /\.css(?:$|[?#])/i

const normalizeModuleId = (id: string): string =>
  id.replaceAll('\\', '/').replace(/^\0+/, '')

const moduleCandidates = (id: string): string[] => {
  const normalized = normalizeModuleId(id)
  const query = normalized.indexOf('?')
  const withoutQuery = query < 0 ? normalized : normalized.slice(0, query)
  return [...new Set([
    normalized,
    normalized.replace(/^\/+/, ''),
    withoutQuery,
    withoutQuery.replace(/^\/+/, ''),
  ])]
}

export const parseSsrViteManifest = (
  source: string,
  filename = '.vite/ssr-manifest.json'
): SsrViteManifest => {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(
      `vue-ssr-lite could not parse ${filename}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`vue-ssr-lite expected ${filename} to contain an object.`)
  }
  for (const [moduleId, assets] of Object.entries(value)) {
    if (!Array.isArray(assets) || assets.some((asset) => typeof asset !== 'string')) {
      throw new Error(
        `vue-ssr-lite expected ${filename} entry ${JSON.stringify(moduleId)} to contain only asset filenames.`
      )
    }
  }
  return value as SsrViteManifest
}

const isAbsoluteHttpUrl = (value: string): boolean =>
  /^https?:\/\//i.test(value) || value.startsWith('//')

export const assertSupportedSsrViteBase = (
  base: string | undefined
): string => {
  if (base === '' || base === './' || base === '.') {
    throw new Error(
      'vue-ssr-lite does not support Vite relative base ("./" or "") for SSR applications because arbitrary request paths cannot resolve its assets deterministically. Use an absolute path base (for example "/products/") or an http(s) CDN base.'
    )
  }
  return base || '/'
}

const joinAssetBase = (base: string, file: string): string => {
  if (/^(?:data|javascript):/i.test(file)) {
    throw new Error(
      `vue-ssr-lite rejected unsafe SSR manifest asset URL ${JSON.stringify(file)}.`
    )
  }
  if (
    /[\\\u0000-\u001f]/.test(file) ||
    file.split(/[?#]/, 1)[0].split('/').includes('..')
  ) {
    throw new Error(
      `vue-ssr-lite rejected unsafe SSR manifest asset path ${JSON.stringify(file)}.`
    )
  }
  // Vite may already include either an absolute path or an absolute CDN base
  // in the authoritative manifest value. Preserve it exactly.
  if (file.startsWith('/') || isAbsoluteHttpUrl(file)) return file
  const cleanFile = file.replace(/^\/+/, '')
  const cleanBase = assertSupportedSsrViteBase(base)
  if (isAbsoluteHttpUrl(cleanBase)) {
    return new URL(cleanFile, cleanBase).href
  }
  return `${cleanBase.endsWith('/') ? cleanBase : `${cleanBase}/`}${cleanFile}`
}

interface SsrManifestAsset {
  identity: string
  href: string
  rel: 'stylesheet' | 'modulepreload'
}

const prepareManifestModule = (files: readonly string[], base: string): readonly SsrManifestAsset[] => {
  const assets: SsrManifestAsset[] = []
  for (const file of files) {
    const rel = STYLESHEET_ASSET_RE.test(file) ? 'stylesheet'
      : JAVASCRIPT_ASSET_RE.test(file) ? 'modulepreload' : undefined
    if (!rel) continue
    const href = joinAssetBase(base, file)
    assets.push({ identity: `${rel}:${href}`, href, rel })
  }
  return assets
}

const collectRenderedAssets = (
  applicationId: string,
  moduleIds: readonly string[],
  resolveModule: (id: string) => readonly SsrManifestAsset[] | undefined
): SsrRenderedApplicationAsset[] => {
  const assets = new Map<string, SsrRenderedApplicationAsset>()
  for (const moduleId of moduleIds) {
    const files = resolveModule(moduleId)
    if (!files) {
      throw new Error(
        `vue-ssr-lite could not resolve rendered module ${JSON.stringify(moduleId)} in Vite's SSR manifest for application ${JSON.stringify(applicationId)}.`
      )
    }
    for (const { identity, href, rel } of files) {
      if (!assets.has(identity)) {
        assets.set(identity, { applicationId, href, rel })
      }
    }
  }
  return [...assets.values()]
}

/** Map only final Vue-rendered module ids through Vite's authoritative manifest. */
export const resolveRenderedApplicationAssets = (options: {
  applicationId: string
  moduleIds: readonly string[]
  base: string
  manifest: SsrViteManifest
}): SsrRenderedApplicationAsset[] => collectRenderedAssets(options.applicationId, options.moduleIds, (id) => {
  const key = moduleCandidates(id).find((candidate) => Object.hasOwn(options.manifest, candidate))
  return key ? prepareManifestModule(options.manifest[key], options.base) : undefined
})

/** Prepare immutable manifest relationships at server startup. Request-specific
 * rendered module IDs still determine the exact asset selection and order. */
export const createSsrRenderedAssetResolver = (manifest: SsrViteManifest, base: string) => {
  const modules = new Map(Object.entries(manifest).map(([id, files]) =>
    [id, prepareManifestModule(files, base)] as const
  ))
  const resolveModule = (id: string) => {
    const key = moduleCandidates(id).find((candidate) => modules.has(candidate))
    return key ? modules.get(key) : undefined
  }
  return (applicationId: string, moduleIds: readonly string[]) =>
    collectRenderedAssets(applicationId, moduleIds, resolveModule)
}
