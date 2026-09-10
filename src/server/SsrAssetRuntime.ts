import type { Stats } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { SsrProductionArtifactError } from '../SsrProductionError'

const mimeTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
}

export interface SsrResolvedProductionAsset {
  readonly filePath: string
  readonly size: number
  readonly contentType: string
  readonly cacheControl: string
  readonly etag: string
  readonly lastModified: string
  readonly mtimeMs: number
}

export interface SsrProductionAssetResolutionOptions {
  readonly clientRoot: string
  readonly pathname: string
  readonly protectedTemplates: readonly string[]
  readonly viteBase?: string
  readonly immutableAssetPaths?: ReadonlySet<string>
  readonly signal?: AbortSignal
  readonly fileSystem?: SsrAssetFileSystem
}

export interface SsrAssetFileSystem {
  realpath(path: string): Promise<string>
  stat(path: string): Promise<Stats>
}

const nodeAssetFileSystem: SsrAssetFileSystem = { realpath, stat }

export const isExpectedUnavailableAssetError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

const isWithinRoot = (root: string, candidate: string): boolean => {
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`
  return candidate === root || candidate.startsWith(rootPrefix)
}

export const effectiveViteBasePath = (viteBase: string | undefined): string => {
  if (!viteBase || viteBase === '/' || viteBase === '.' || viteBase === './') {
    return '/'
  }
  let basePath = viteBase
  try {
    if (/^https?:\/\//i.test(viteBase) || viteBase.startsWith('//')) {
      basePath = new URL(viteBase, 'https://vue-ssr-lite.invalid').pathname
    }
  } catch {
    return '/'
  }
  if (!basePath.startsWith('/')) return '/'
  return basePath.endsWith('/') ? basePath : `${basePath}/`
}

const stripViteBase = (pathname: string, viteBase: string | undefined): string => {
  const basePath = effectiveViteBasePath(viteBase)
  if (basePath === '/') return pathname
  const baseWithoutSlash = basePath.slice(0, -1)
  if (pathname === baseWithoutSlash) return '/'
  return pathname.startsWith(basePath)
    ? `/${pathname.slice(basePath.length)}`
    : pathname
}

const decodeAssetPath = (
  pathname: string,
  viteBase: string | undefined
): string | null => {
  let decoded: string
  try {
    decoded = decodeURIComponent(stripViteBase(pathname, viteBase))
  } catch {
    return null
  }
  // Backslashes are URL data, never alternate filesystem separators. Rejecting
  // them also closes Windows traversal variants before path resolution.
  if (/[\\\u0000-\u001f\u007f]/.test(decoded)) return null
  const relativePath = decoded.replace(/^\/+/, '')
  if (!relativePath) return null
  if (relativePath.split('/').includes('..')) return null
  return relativePath
}

const PRIVATE_BUILD_DIRECTORIES = new Set(['.vite', '.vue-ssr-lite'])
const isPrivateBuildMetadataPath = (relativePath: string): boolean =>
  PRIVATE_BUILD_DIRECTORIES.has(relativePath.split('/', 1)[0].toLowerCase())

/**
 * Identify reserved production build metadata before normal document routing
 * can treat an unresolved asset as an application navigation. This uses the
 * same base/path decoding rules as the asset resolver, but intentionally only
 * needs to classify the first path segment.
 */
export const isSsrPrivateProductionAssetPath = (
  pathname: string,
  viteBase?: string
): boolean => {
  const strippedPath = stripViteBase(pathname, viteBase).replace(/^\/+/, '')
  const firstSegment = strippedPath.split('/', 1)[0]
  if (!firstSegment) return false
  try {
    return (
      PRIVATE_BUILD_DIRECTORIES.has(decodeURIComponent(firstSegment).replace(/^\/+/, '').split('/', 1)[0].toLowerCase())
    )
  } catch {
    return false
  }
}

const normalizeManifestAssetPath = (value: string): string => {
  if (
    !value ||
    /^(?:[a-z]+:)?\/\//i.test(value) ||
    /[?#\\\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new SsrProductionArtifactError('client-manifest.invalid-path')
  }
  const normalized = value.replace(/^\/+/, '')
  if (!normalized || normalized.split('/').includes('..')) {
    throw new SsrProductionArtifactError('client-manifest.invalid-path')
  }
  return normalized
}

/** Resolve the authoritative set of Vite-emitted client files. Public-directory
 * copies are intentionally absent, so hash-looking mutable names remain on the
 * conservative cache policy. */
export const parseSsrClientAssetManifest = (
  source: string,
  _filename = '.vite/manifest.json'
): ReadonlySet<string> => {
  let manifest: unknown
  try {
    manifest = JSON.parse(source)
  } catch {
    throw new SsrProductionArtifactError('client-manifest.invalid-json')
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new SsrProductionArtifactError('client-manifest.invalid-schema')
  }

  const emitted = new Set<string>()
  for (const value of Object.values(manifest)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new SsrProductionArtifactError('client-manifest.invalid-schema')
    }
    const entry = value as Record<string, unknown>
    if (typeof entry.file !== 'string') {
      throw new SsrProductionArtifactError('client-manifest.invalid-schema')
    }
    const candidates = [entry.file]
    for (const field of ['css', 'assets'] as const) {
      const files = entry[field]
      if (files === undefined) continue
      if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) {
        throw new SsrProductionArtifactError('client-manifest.invalid-schema')
      }
      candidates.push(...(files as string[]))
    }
    for (const candidate of candidates) {
      emitted.add(normalizeManifestAssetPath(candidate))
    }
  }
  return emitted
}

export const resolveSsrImmutableAssetPaths = (
  manifestAssets: ReadonlySet<string>,
  revisionedAssets: ReadonlySet<string>
): ReadonlySet<string> =>
  new Set(
    [...revisionedAssets].filter((assetPath) => manifestAssets.has(assetPath))
  )

const createEtag = (information: Pick<Stats, 'size' | 'mtimeMs'>): string =>
  `W/"${information.size.toString(16)}-${Math.trunc(information.mtimeMs).toString(16)}"`

export const updateSsrProductionAssetMetadata = (
  asset: SsrResolvedProductionAsset,
  information: Stats
): SsrResolvedProductionAsset => ({
  ...asset,
  size: information.size,
  etag: createEtag(information),
  lastModified: information.mtime.toUTCString(),
  mtimeMs: information.mtimeMs,
})

const splitEtags = (value: string): string[] => {
  const tags: string[] = []
  let start = 0
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '"') quoted = !quoted
    if (character === ',' && !quoted) {
      tags.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  tags.push(value.slice(start).trim())
  return tags.filter(Boolean)
}

const weakEtagValue = (value: string): string =>
  value.trim().replace(/^W\//i, '')

export const isSsrProductionAssetNotModified = (
  asset: SsrResolvedProductionAsset,
  headers: Readonly<Record<string, string | readonly string[] | undefined>>
): boolean => {
  const ifNoneMatchValue = headers['if-none-match']
  if (ifNoneMatchValue !== undefined) {
    const ifNoneMatch =
      typeof ifNoneMatchValue === 'string'
        ? ifNoneMatchValue
        : ifNoneMatchValue.join(',')
    const expected = weakEtagValue(asset.etag)
    return splitEtags(ifNoneMatch).some(
      (candidate) => candidate === '*' || weakEtagValue(candidate) === expected
    )
  }

  const ifModifiedSinceValue = headers['if-modified-since']
  if (ifModifiedSinceValue === undefined) return false
  const ifModifiedSince =
    typeof ifModifiedSinceValue === 'string'
      ? ifModifiedSinceValue
      : ifModifiedSinceValue[0]
  const validatorTime = Date.parse(ifModifiedSince)
  if (!Number.isFinite(validatorTime)) return false
  // HTTP dates have one-second precision; sub-second filesystem precision must
  // not make an otherwise equal Last-Modified validator appear stale.
  return Math.floor(asset.mtimeMs / 1000) <= Math.floor(validatorTime / 1000)
}

export const resolveSsrProductionAsset = async (
  options: SsrProductionAssetResolutionOptions
): Promise<SsrResolvedProductionAsset | null> => {
  const fileSystem = options.fileSystem ?? nodeAssetFileSystem
  try {
    options.signal?.throwIfAborted()
    const relativePath = decodeAssetPath(options.pathname, options.viteBase)
    if (!relativePath) return null
    // Vite manifests and vue-ssr-lite's build metadata are server inputs, not
    // browser assets. Keep the complete reserved namespace out of generic
    // static serving before any filesystem lookup or response metadata work.
    if (isPrivateBuildMetadataPath(relativePath)) return null

    const canonicalRoot = await fileSystem.realpath(resolve(options.clientRoot))
    options.signal?.throwIfAborted()
    const lexicalPath = resolve(canonicalRoot, relativePath)
    if (!isWithinRoot(canonicalRoot, lexicalPath)) return null

    const protectedLexicalPaths = new Set(
      options.protectedTemplates.map((template) =>
        resolve(canonicalRoot, template)
      )
    )
    if (protectedLexicalPaths.has(lexicalPath)) return null

    const filePath = await fileSystem.realpath(lexicalPath)
    options.signal?.throwIfAborted()
    // realpath containment prevents an in-root symlink from exposing an
    // arbitrary file outside the configured client output directory.
    if (!isWithinRoot(canonicalRoot, filePath)) return null

    const protectedCanonicalPaths = new Set(
      await Promise.all(
        [...protectedLexicalPaths].map(async (templatePath) => {
          try {
            return await fileSystem.realpath(templatePath)
          } catch (error) {
            if (!isExpectedUnavailableAssetError(error)) throw error
            return templatePath
          }
        })
      )
    )
    if (protectedCanonicalPaths.has(filePath)) return null

    const information = await fileSystem.stat(filePath)
    options.signal?.throwIfAborted()
    if (!information.isFile()) return null

    const asset: SsrResolvedProductionAsset = {
      filePath,
      size: information.size,
      contentType:
        mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
      cacheControl: options.immutableAssetPaths?.has(relativePath)
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
      etag: createEtag(information),
      lastModified: information.mtime.toUTCString(),
      mtimeMs: information.mtimeMs,
    }
    return asset
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (isExpectedUnavailableAssetError(error)) return null
    throw error
  }
}
