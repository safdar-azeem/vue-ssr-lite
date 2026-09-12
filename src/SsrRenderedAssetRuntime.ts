import type { SsrRenderedApplicationAsset } from './SsrApplicationAssetRuntime'
import { SsrProductionArtifactError } from './SsrProductionError'
import { posix, win32 } from 'node:path'

export type SsrViteManifest = Readonly<Record<string, readonly string[]>>

const JAVASCRIPT_ASSET_RE = /\.(?:js|mjs)(?:$|[?#])/i
const STYLESHEET_ASSET_RE = /\.css(?:$|[?#])/i
const VUE_BLOCK_QUERY_FIELDS = new Set(['vue', 'type', 'setup', 'index', 'scoped', 'id', 'inline'])

const moduleIdentity = (id: string, root?: string): string => {
  let identity = id.replaceAll('\\', '/')
  // Vite 7 and plugin-vue both use normalizePath(relative(config.root, id)).
  // Runtime filesystem location is irrelevant after the portable build moves.
  // Do not strip guessed prefixes, /@fs/, null bytes, or package directories.
  if (root && !identity.includes('\0')) {
    const paths = /^[a-z]:\//i.test(root.replaceAll('\\', '/')) || root.startsWith('\\\\') || root.startsWith('//')
      ? win32 : posix
    if (paths.isAbsolute(identity)) identity = paths.relative(root, identity).replaceAll('\\', '/')
  }

  // Vue registers the SFC filename in ssrContext.modules. Rollup can eliminate
  // its client facade, leaving only ?vue&type=script (and style/template) keys
  // in Vite's SSR manifest. These blocks belong to that exact SFC, so aggregate
  // their authoritative entries even when the facade itself has no entry.
  // Unrelated queries and external src blocks keep their distinct identities.
  const queryAt = identity.indexOf('?')
  if (queryAt < 0) return identity
  const filename = identity.slice(0, queryAt)
  const query = new URLSearchParams(identity.slice(queryAt + 1))
  if (filename.endsWith('.vue') && query.has('vue') &&
      ['script', 'template', 'style', 'custom'].includes(query.get('type') ?? '') &&
      [...query.keys()].every((key) => VUE_BLOCK_QUERY_FIELDS.has(key) || /^lang\.[\w-]+$/.test(key))) return filename
  return identity
}

export const parseSsrViteManifest = (
  source: string,
  _filename = '.vite/ssr-manifest.json'
): SsrViteManifest => {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new SsrProductionArtifactError('ssr-manifest.invalid-json')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SsrProductionArtifactError('ssr-manifest.invalid-schema')
  }
  for (const assets of Object.values(value)) {
    if (!Array.isArray(assets) || assets.some((asset) => typeof asset !== 'string')) {
      throw new SsrProductionArtifactError('ssr-manifest.invalid-schema')
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
  if (!file || (/^[a-z][\w+.-]*:/i.test(file) && !/^https?:\/\//i.test(file))) {
    throw new SsrProductionArtifactError('rendered-assets.invalid-asset')
  }
  if (
    /[\\\u0000-\u001f\u007f]/.test(file) ||
    file.split(/[?#]/, 1)[0].split('/').includes('..')
  ) {
    throw new SsrProductionArtifactError('rendered-assets.invalid-asset')
  }
  // Vite may already include either an absolute path or an absolute CDN base
  // in the authoritative manifest value. Preserve it exactly.
  if (isAbsoluteHttpUrl(file)) {
    try {
      const parsed = new URL(file, 'https://vue-ssr-lite.invalid')
      if (parsed.username || parsed.password) throw new Error()
    } catch {
      throw new SsrProductionArtifactError('rendered-assets.invalid-asset')
    }
    return file
  }
  if (file.startsWith('/')) return file
  const cleanFile = file.replace(/^\/+/, '')
  const cleanBase = assertSupportedSsrViteBase(base)
  if (isAbsoluteHttpUrl(cleanBase)) {
    try {
      return new URL(cleanFile, cleanBase).href
    } catch {
      throw new SsrProductionArtifactError('rendered-assets.invalid-asset')
    }
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
    const href = joinAssetBase(base, file)
    const rel = STYLESHEET_ASSET_RE.test(file) ? 'stylesheet'
      : JAVASCRIPT_ASSET_RE.test(file) ? 'modulepreload' : undefined
    if (!rel) continue
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
      throw new SsrProductionArtifactError('rendered-assets.module-not-in-manifest')
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
  /** Original Vite build root, carried internally by the generated runtime. */
  root?: string
}): SsrRenderedApplicationAsset[] =>
  createSsrRenderedAssetResolver(options.manifest, options.base, options.root)(options.applicationId, options.moduleIds)

/** Prepare immutable manifest relationships at server startup. Request-specific
 * rendered module IDs still determine the exact asset selection and order. */
export const createSsrRenderedAssetResolver = (manifest: SsrViteManifest, base: string, root?: string) => {
  const indexed = new Map<string, Map<string, SsrManifestAsset>>()
  // Shared chunks occur in many manifest entries and Vue block aliases. Join
  // and validate each distinct asset once, then deduplicate each module once.
  const filesByName = new Map<string, readonly SsrManifestAsset[]>()
  for (const [id, files] of Object.entries(manifest)) {
    const identity = moduleIdentity(id, root)
    const assets = indexed.get(identity) ?? new Map<string, SsrManifestAsset>()
    for (const file of files) {
      let prepared = filesByName.get(file)
      if (!prepared) {
        prepared = prepareManifestModule([file], base)
        filesByName.set(file, prepared)
      }
      for (const asset of prepared) assets.set(asset.identity, asset)
    }
    // An authoritative empty entry is meaningful: eager CSS/JS already lives
    // in the HTML template. Missing entries must still fail below.
    indexed.set(identity, assets)
  }
  const modules = new Map([...indexed].map(([id, assets]) => [id, [...assets.values()]]))
  return (applicationId: string, moduleIds: readonly string[]) =>
    collectRenderedAssets(applicationId, moduleIds, (id) => modules.get(id) ?? modules.get(moduleIdentity(id, root)))
}
