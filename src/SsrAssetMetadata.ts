import { SsrProductionArtifactError } from './SsrProductionError'

export const SSR_PRODUCTION_ASSET_METADATA_PATH =
  '.vite/vue-ssr-lite-assets.json'

interface SsrProductionAssetMetadata {
  version: 1
  immutable: string[]
}

const normalizeAssetPath = (value: string): string => {
  if (
    !value ||
    /^(?:[a-z]+:)?\/\//i.test(value) ||
    /[?#\\\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new SsrProductionArtifactError('asset-cache-metadata.invalid-path')
  }
  const normalized = value.replace(/^\/+/, '')
  if (!normalized || normalized.split('/').includes('..')) {
    throw new SsrProductionArtifactError('asset-cache-metadata.invalid-path')
  }
  return normalized
}

export const serializeSsrProductionAssetMetadata = (
  immutable: readonly string[]
): string =>
  JSON.stringify({
    version: 1,
    immutable: [...new Set(immutable)].sort(),
  } satisfies SsrProductionAssetMetadata)

export const parseSsrProductionAssetMetadata = (
  source: string,
  _filename = SSR_PRODUCTION_ASSET_METADATA_PATH
): ReadonlySet<string> => {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new SsrProductionArtifactError('asset-cache-metadata.invalid-json')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SsrProductionArtifactError('asset-cache-metadata.invalid-schema')
  }
  const metadata = value as Partial<SsrProductionAssetMetadata>
  if (
    metadata.version !== 1 ||
    !Array.isArray(metadata.immutable) ||
    metadata.immutable.some((path) => typeof path !== 'string')
  ) {
    throw new SsrProductionArtifactError('asset-cache-metadata.invalid-schema')
  }
  return new Set(
    metadata.immutable.map((path) => normalizeAssetPath(path))
  )
}
