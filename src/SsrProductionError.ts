/** Safe, framework-owned diagnostics. Never interpolate paths or exception text. */
const PRODUCTION_FAILURES = {
  'client-manifest.missing': 'The Vite client manifest is missing. Rebuild and deploy the client and server artifacts together.',
  'client-manifest.read-failed': 'The Vite client manifest could not be read. Check deployment file access.',
  'client-manifest.invalid-json': 'vue-ssr-lite could not parse the Vite client manifest JSON. Rebuild the client output.',
  'client-manifest.invalid-schema': 'The Vite client manifest must contain an object whose entries contain a file and optional arrays of asset filenames.',
  'client-manifest.invalid-path': 'Invalid Vite client manifest asset path. Rebuild with supported Vite asset paths.',
  'asset-cache-metadata.missing': 'The vue-ssr-lite asset cache metadata is missing. Rebuild the client output to restore immutable asset caching.',
  'asset-cache-metadata.read-failed': 'The vue-ssr-lite asset cache metadata could not be read. Check deployment file access.',
  'asset-cache-metadata.invalid-json': 'vue-ssr-lite could not parse the asset cache metadata JSON. Rebuild the client output.',
  'asset-cache-metadata.invalid-schema': 'The asset cache metadata must contain version 1 immutable asset metadata.',
  'asset-cache-metadata.invalid-path': 'vue-ssr-lite rejected invalid asset path in the asset cache metadata. Rebuild the client output.',
  'ssr-manifest.missing': 'The Vite SSR manifest is missing. Rebuild and deploy the client and server artifacts together.',
  'ssr-manifest.read-failed': 'The Vite SSR manifest could not be read. Check deployment file access.',
  'ssr-manifest.invalid-json': 'vue-ssr-lite could not parse the Vite SSR manifest JSON. Rebuild the client output.',
  'ssr-manifest.invalid-schema': 'The Vite SSR manifest must contain an object whose entries contain only asset filenames.',
  'rendered-assets.module-not-in-manifest': 'vue-ssr-lite could not resolve rendered module identity in the Vite SSR manifest. The client and SSR module graphs do not agree; rebuild both with the same Vite configuration.',
  'rendered-assets.invalid-asset': 'The Vite SSR manifest contains an invalid or unsafe asset URL/path. Check the build asset/base contract.',
} as const

export type SsrProductionFailureCode = keyof typeof PRODUCTION_FAILURES

// Transport, bundled renderer and Vite can instantiate separate module copies.
// The shared symbol identifies a code; only our allowlisted literals get logged.
const PRODUCTION_FAILURE = Symbol.for('vue-ssr-lite.internal.production-failure')

export class SsrProductionArtifactError extends Error {
  readonly [PRODUCTION_FAILURE]: SsrProductionFailureCode

  constructor(code: SsrProductionFailureCode) {
    super(`[vue-ssr-lite] ${code}: ${PRODUCTION_FAILURES[code]}`)
    this.name = 'SsrProductionArtifactError'
    this[PRODUCTION_FAILURE] = code
  }
}

export const readSsrProductionFailure = (error: unknown) => {
  try {
    if (!error || typeof error !== 'object') return undefined
    const code = (error as SsrProductionArtifactError)[PRODUCTION_FAILURE]
    if (typeof code !== 'string' || !Object.hasOwn(PRODUCTION_FAILURES, code)) return undefined
    const [artifact, reason] = code.split('.')
    return { code, artifact, reason, message: PRODUCTION_FAILURES[code] }
  } catch {
    return undefined
  }
}
