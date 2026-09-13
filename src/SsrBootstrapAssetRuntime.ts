import { SSR_BROWSER_BOOTSTRAP_SOURCES, type SsrBrowserBootstrapCapability } from './SsrBrowserBootstrap'
import type { SsrRenderedApplicationAsset } from './SsrApplicationAssetRuntime'
import { joinSsrAssetBase } from './SsrRenderedAssetRuntime'
import { SsrProductionArtifactError } from './SsrProductionError'

export const SSR_BROWSER_BOOTSTRAP_METADATA_PATH = '.vite/vue-ssr-lite-bootstrap.json'
export type SsrBootstrapPreloadPolicy = 'enabled' | 'disabled' | 'resolve-dependencies' | 'render-built-url'
export interface SsrBootstrapApplicationAssets {
  initial: readonly SsrBrowserBootstrapCapability[]
  capabilities: Partial<Record<SsrBrowserBootstrapCapability, readonly string[]>>
}
export interface SsrBootstrapAssetManifest {
  version: 1
  policy: SsrBootstrapPreloadPolicy
  applications: Readonly<Record<string, SsrBootstrapApplicationAssets>>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
const capability = (value: unknown): value is SsrBrowserBootstrapCapability =>
  typeof value === 'string' && Object.hasOwn(SSR_BROWSER_BOOTSTRAP_SOURCES, value)
const fail = (code: 'invalid-json' | 'invalid-schema' | 'invalid-path'): never => { throw new SsrProductionArtifactError(`bootstrap-metadata.${code}`) }

/** Only literal outDir-relative browser JS identities may enter this artifact. */
export const isSsrBootstrapAssetPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 &&
  !/[?#%:\\<>"'\u0000-\u0020\u007f]/.test(value) &&
  value.split('/').every((part) => Boolean(part) && !part.startsWith('.')) &&
  /\.(?:js|mjs)$/.test(value)

export const parseSsrBootstrapAssetManifest = (source: string): SsrBootstrapAssetManifest => {
  let value: unknown
  try { value = JSON.parse(source) } catch { return fail('invalid-json') }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.applications) ||
      !['enabled', 'disabled', 'resolve-dependencies', 'render-built-url'].includes(String(value.policy)) ||
      Object.keys(value).some((key) => !['version', 'policy', 'applications'].includes(key))) return fail('invalid-schema')
  const applications: Record<string, SsrBootstrapApplicationAssets> = Object.create(null)
  for (const [id, entry] of Object.entries(value.applications)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || !isRecord(entry) ||
        !Array.isArray(entry.initial) || !entry.initial.every(capability) || !isRecord(entry.capabilities) ||
        Object.keys(entry).some((key) => !['initial', 'capabilities'].includes(key))) return fail('invalid-schema')
    const capabilities: SsrBootstrapApplicationAssets['capabilities'] = Object.create(null)
    for (const [key, files] of Object.entries(entry.capabilities)) {
      if (!capability(key) || !Array.isArray(files)) return fail('invalid-schema')
      if (!files.every(isSsrBootstrapAssetPath)) return fail('invalid-path')
      if (value.policy !== 'enabled' && files.length) return fail('invalid-schema')
      capabilities[key] = Object.freeze([...new Set(files)].sort())
    }
    applications[id] = Object.freeze({
      initial: Object.freeze([...new Set(entry.initial)].sort()),
      capabilities: Object.freeze(capabilities),
    })
  }
  return Object.freeze({ version: 1, policy: value.policy as SsrBootstrapPreloadPolicy, applications: Object.freeze(applications) })
}

/** Validation, URL joining and application-owned links happen once at startup. */
export const createSsrBootstrapAssetResolver = (
  manifest: SsrBootstrapAssetManifest,
  base: string,
  boundInitial: ReadonlyMap<string, readonly SsrBrowserBootstrapCapability[]> = new Map()
) => {
  // Relative bases cannot be joined safely for arbitrary request paths. SSR
  // already rejects them; an existing pure SPA deployment keeps normal imports.
  if (base === '' || base === '.' || base === './') {
    return (_applicationId: string, _request: readonly SsrBrowserBootstrapCapability[] = []): readonly SsrRenderedApplicationAsset[] => []
  }
  const applications = new Map(Object.entries(manifest.applications).map(([id, entry]) => [id, {
    initial: Object.freeze([...new Set([...entry.initial, ...(boundInitial.get(id) ?? [])])]),
    capabilities: new Map(Object.entries(entry.capabilities).map(([key, files]) => [key,
      files.map((file): SsrRenderedApplicationAsset => Object.freeze({
        applicationId: id, href: joinSsrAssetBase(base, file), rel: 'modulepreload',
      })),
    ])),
  }]))
  return (applicationId: string, request: readonly SsrBrowserBootstrapCapability[] = []): readonly SsrRenderedApplicationAsset[] => {
    if (manifest.policy !== 'enabled') return []
    const application = applications.get(applicationId)
    if (!application) return []
    const links = new Map<string, SsrRenderedApplicationAsset>()
    for (const key of new Set([...application.initial, ...request])) {
      for (const asset of application.capabilities.get(key) ?? []) links.set(asset.href, asset)
    }
    return [...links.values()]
  }
}
