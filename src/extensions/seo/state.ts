import { isRef } from 'vue'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { applySeoLayerResponseStatus } from '../../SsrResponseStatus'
import type { SsrResponseState } from '../../SsrRuntimeTypes'
import type {
  JsonObject,
  SeoApplicationConfig,
  SeoImageInput,
  SeoImageValue,
  SeoLinkEntry,
  SeoMediaInput,
  SeoMediaValue,
  SeoMetaEntry,
  SeoOpenGraphInput,
  SeoPageInput,
  SeoRouteInput,
  SeoSiteDefaults,
  UseSeoInput,
  UseSeoSource,
} from './types'

export interface SeoLayer {
  id: number
  active: boolean
  input: UseSeoSource
}

export interface SeoState {
  readonly config: SeoApplicationConfig
  readonly siteDefaults?: SeoSiteDefaults
  layers: SeoLayer[]
  nextLayerId: number
}

export interface SeoResolvedInput extends SeoPageInput {
  siteName?: string | null
  titleTemplate?: string | null
}

export const createSeoState = (
  config: SeoApplicationConfig = {},
  siteDefaults?: SeoSiteDefaults
): SeoState => ({ config, siteDefaults, layers: [], nextLayerId: 1 })

export const resolveSeoValue = <T>(
  value: T | (() => T) | { value: T } | undefined
): T | undefined => {
  if (value == null) return value as T | undefined
  if (typeof value === 'function') return (value as () => T)()
  if (isRef(value)) return (value as { value: T }).value
  return value as T
}

const PAGE_FIELDS = new Set<keyof SeoPageInput>([
  'title', 'description', 'image', 'canonical', 'index', 'follow', 'status',
  'openGraph', 'twitter', 'robots', 'alternates', 'structuredData',
  'structuredDataMode', 'meta', 'links', 'htmlAttributes',
])

const isWholeObjectSource = (input: UseSeoSource): boolean =>
  typeof input === 'function' || isRef(input)

export const resolveUseSeoInput = (input: UseSeoSource): SeoPageInput => {
  if (isWholeObjectSource(input)) return resolveSeoValue(input as any) ?? {}
  const record = input as UseSeoInput
  const resolved: Record<string, unknown> = {}
  for (const field of PAGE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      resolved[field] = resolveSeoValue(record[field] as any)
    }
  }
  return resolved as SeoPageInput
}

const composeSingleton = <T>(base: T | undefined, override: T | undefined): T | undefined =>
  override === undefined ? base : override

const composeObject = <T extends Record<string, any>>(
  base: T | null | undefined,
  override: T | null | undefined
): T | null | undefined => {
  if (override === undefined) return base
  if (override === null) return null
  if (base == null) return { ...override }
  return { ...base, ...Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined)) }
}

const normalizeRepeatable = <T extends SeoImageInput | SeoMediaInput>(
  value: string | T | readonly (string | T)[] | undefined
): T[] => {
  if (value === undefined) return []
  const values = Array.isArray(value) ? value : [value]
  return values.map((item) => typeof item === 'string' ? ({ url: item } as T) : ({ ...item } as T))
}

const composeRepeatable = <T extends SeoImageInput | SeoMediaInput>(
  base: string | T | readonly (string | T)[] | undefined,
  override: string | T | readonly (string | T)[] | undefined
): T[] | undefined => {
  if (override === undefined) return base === undefined ? undefined : normalizeRepeatable(base)
  const output = normalizeRepeatable(base)
  for (const entry of normalizeRepeatable(override)) {
    if (entry.key) {
      const index = output.findIndex((current) => current.key === entry.key)
      if (index >= 0) output.splice(index, 1)
    }
    output.push(entry)
  }
  return output
}

const composeLocales = (
  base: readonly string[] | undefined,
  override: readonly string[] | undefined
): string[] | undefined => {
  if (override === undefined) return base ? [...base] : undefined
  const output = [...(base ?? [])]
  for (const locale of override) {
    const previous = output.indexOf(locale)
    if (previous >= 0) output.splice(previous, 1)
    output.push(locale)
  }
  return output
}

const composeOpenGraph = (
  base: SeoOpenGraphInput | null | undefined,
  override: SeoOpenGraphInput | null | undefined
): SeoOpenGraphInput | null | undefined => {
  if (override === undefined) return base
  if (override === null) return null
  const source = base ?? {}
  const merged: SeoOpenGraphInput = {
    ...source,
    ...Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined)),
  }
  merged.image = composeRepeatable(
    source.image as SeoImageValue | undefined,
    override.image as SeoImageValue | undefined
  )
  merged.audio = composeRepeatable(
    source.audio as SeoMediaValue | undefined,
    override.audio as SeoMediaValue | undefined
  )
  merged.video = composeRepeatable(
    source.video as SeoMediaValue | undefined,
    override.video as SeoMediaValue | undefined
  )
  merged.localeAlternate = composeLocales(source.localeAlternate, override.localeAlternate)
  return merged
}

const metaIdentity = (entry: SeoMetaEntry): string => {
  const name = entry.name?.toLowerCase()
  const property = entry.property?.toLowerCase()
  const equiv = entry.httpEquiv?.toLowerCase()
  if (name === 'description' || name === 'robots') return `meta:name:${name}`
  if (property === 'og:url') return 'meta:property:og:url'
  return entry.key ? `key:${entry.key}` : `meta:${name ?? ''}:${property ?? ''}:${equiv ?? ''}`
}

const linkIdentity = (entry: SeoLinkEntry): string => {
  const rel = entry.rel.toLowerCase()
  if (rel === 'canonical') return 'link:canonical'
  if (rel === 'alternate' && entry.hreflang) return `link:alternate:${entry.hreflang.toLowerCase()}`
  return entry.key
    ? `key:${entry.key}`
    : `link:${rel}:${entry.hreflang?.toLowerCase() ?? ''}:${entry.media ?? ''}:${entry.href}`
}

const composeCollection = <T>(
  base: readonly T[] | null | undefined,
  override: readonly T[] | null | undefined,
  identity: (entry: T) => string
): T[] | null | undefined => {
  if (override === undefined) return base == null ? base : [...base]
  if (override === null) return null
  const output = base == null ? [] : [...base]
  for (const item of override) {
    const key = identity(item)
    const index = output.findIndex((current) => identity(current) === key)
    if (index >= 0) output.splice(index, 1)
    output.push(item)
  }
  return output
}

const jsonBlocks = (
  value: JsonObject | readonly JsonObject[] | null | undefined
): JsonObject[] => value == null ? [] : Array.isArray(value) ? [...value] : [value as JsonObject]

const jsonIdentity = (block: JsonObject): string | undefined =>
  typeof block['@id'] === 'string' ? block['@id'] : undefined

const composeStructuredData = (
  base: SeoPageInput['structuredData'],
  override: SeoPageInput['structuredData'],
  mode: SeoPageInput['structuredDataMode']
): SeoPageInput['structuredData'] => {
  if (override === undefined) return base
  if (override === null) return null
  const output = mode === 'replace' ? [] : jsonBlocks(base)
  for (const block of jsonBlocks(override)) {
    const id = jsonIdentity(block)
    if (id) {
      const index = output.findIndex((current) => jsonIdentity(current) === id)
      if (index >= 0) output.splice(index, 1)
    }
    output.push(block)
  }
  return output
}

const composeAlternates = (
  base: SeoPageInput['alternates'],
  override: SeoPageInput['alternates']
): SeoPageInput['alternates'] => {
  if (override === undefined) return base
  if (override === null) return null
  const languages = { ...(base?.languages ?? {}) }
  for (const [language, value] of Object.entries(override.languages ?? {})) {
    if (value === null) delete languages[language]
    else languages[language] = value
  }
  return { languages }
}

export const mergeSeoInput = (
  base: SeoResolvedInput,
  override: SeoResolvedInput
): SeoResolvedInput => {
  const result: SeoResolvedInput = { ...base }
  for (const key of [
    'title', 'siteName', 'titleTemplate', 'description', 'image', 'canonical',
    'index', 'follow', 'status',
  ] as const) {
    result[key] = composeSingleton(base[key] as any, override[key] as any) as never
  }
  result.openGraph = composeOpenGraph(base.openGraph, override.openGraph)
  result.twitter = composeObject(base.twitter, override.twitter)
  result.robots = composeObject(base.robots, override.robots)
  result.alternates = composeAlternates(base.alternates, override.alternates)
  result.meta = composeCollection(base.meta, override.meta, metaIdentity)
  result.links = composeCollection(base.links, override.links, linkIdentity)
  result.structuredData = composeStructuredData(
    base.structuredData,
    override.structuredData,
    override.structuredDataMode
  )
  result.structuredDataMode = override.structuredDataMode ?? base.structuredDataMode
  result.htmlAttributes = composeObject(base.htmlAttributes, override.htmlAttributes) ?? undefined
  return result
}

const applicationSeoInput = (config: SeoApplicationConfig): SeoResolvedInput => ({
  title: config.title,
  siteName: config.siteName,
  titleTemplate: config.titleTemplate,
  description: config.description,
  image: config.image,
  index: config.index,
  follow: config.follow,
  openGraph: config.openGraph,
  twitter: config.twitter,
  robots: config.robots,
  structuredData: config.structuredData,
  structuredDataMode: config.structuredDataMode,
  meta: config.meta,
  links: config.links,
  htmlAttributes: config.htmlAttributes,
})

const siteSeoInput = (defaults: SeoSiteDefaults): SeoResolvedInput => ({ ...defaults })

export const routeSeoLayers = (
  route: RouteLocationNormalizedLoaded | null | undefined
): SeoRouteInput[] => {
  if (route?.matched?.length) {
    return route.matched
      .map((record) => record.meta?.seo as SeoRouteInput | undefined)
      .filter((value): value is SeoRouteInput => Boolean(value))
  }
  return route?.meta?.seo ? [route.meta.seo as SeoRouteInput] : []
}

export const mergeSeoLayers = (
  state: SeoState,
  route: RouteLocationNormalizedLoaded | SeoPageInput | null | undefined
): SeoResolvedInput => {
  let merged = applicationSeoInput(state.config)
  if (state.siteDefaults) merged = mergeSeoInput(merged, siteSeoInput(state.siteDefaults))
  const routeLayers =
    route && 'matched' in route
      ? routeSeoLayers(route)
      : route
        ? [route as SeoPageInput]
        : []
  for (const routeLayer of routeLayers) merged = mergeSeoInput(merged, routeLayer)
  for (const layer of state.layers) {
    if (layer.active) merged = mergeSeoInput(merged, resolveUseSeoInput(layer.input))
  }
  return merged
}

/** Recompute the complete declarative SEO status without outranking Core overrides. */
export const recomputeSeoResponseStatus = (
  state: SeoState,
  response: SsrResponseState,
  route: RouteLocationNormalizedLoaded | null | undefined
): number =>
  applySeoLayerResponseStatus(response, route, mergeSeoLayers(state, route).status)

export const registerSeoLayer = (state: SeoState, input: UseSeoSource): SeoLayer => {
  const layer = { id: state.nextLayerId++, active: true, input }
  state.layers.push(layer)
  return layer
}

export const removeSeoLayer = (state: SeoState, layer: SeoLayer): void => {
  const index = state.layers.indexOf(layer)
  if (index >= 0) state.layers.splice(index, 1)
}
