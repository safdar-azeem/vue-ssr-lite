export const SSR_PRODUCTION_ASSET_METADATA_PATH =
  '.vite/vue-ssr-lite-assets.json'

interface SsrProductionAssetMetadata {
  version: 1
  immutable: string[]
}

const normalizeAssetPath = (value: string, filename: string): string => {
  if (
    !value ||
    /^(?:[a-z]+:)?\/\//i.test(value) ||
    /[?#\\\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(
      `vue-ssr-lite rejected invalid asset path ${JSON.stringify(value)} in ${filename}.`
    )
  }
  const normalized = value.replace(/^\/+/, '')
  if (!normalized || normalized.split('/').includes('..')) {
    throw new Error(
      `vue-ssr-lite rejected invalid asset path ${JSON.stringify(value)} in ${filename}.`
    )
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
  filename = SSR_PRODUCTION_ASSET_METADATA_PATH
): ReadonlySet<string> => {
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
  const metadata = value as Partial<SsrProductionAssetMetadata>
  if (
    metadata.version !== 1 ||
    !Array.isArray(metadata.immutable) ||
    metadata.immutable.some((path) => typeof path !== 'string')
  ) {
    throw new Error(
      `vue-ssr-lite expected ${filename} to contain version 1 immutable asset metadata.`
    )
  }
  return new Set(
    metadata.immutable.map((path) => normalizeAssetPath(path, filename))
  )
}
