import { isRef } from 'vue'
import type { SeoApplicationConfig, SeoInput, UseSeoInput } from './types'

export interface SeoLayer {
  id: number
  active: boolean
  input: UseSeoInput
}

export interface SeoState {
  readonly config: SeoApplicationConfig
  layers: SeoLayer[]
  nextLayerId: number
}

export const createSeoState = (
  config: SeoApplicationConfig = {}
): SeoState => ({
  config,
  layers: [],
  nextLayerId: 1,
})

export const resolveSeoValue = <T>(
  value: T | (() => T) | { value: T } | undefined
): T | undefined => {
  if (value == null) return value as T | undefined
  if (typeof value === 'function') return (value as () => T)()
  if (isRef(value)) return (value as { value: T }).value
  return value as T
}

export const resolveUseSeoInput = (input: UseSeoInput): SeoInput => ({
  title: resolveSeoValue(input.title),
  description: resolveSeoValue(input.description),
  image: resolveSeoValue(input.image),
  canonical: resolveSeoValue(input.canonical),
  index: resolveSeoValue(input.index),
  follow: resolveSeoValue(input.follow),
  openGraph: resolveSeoValue(input.openGraph),
  twitter: resolveSeoValue(input.twitter),
  robots: resolveSeoValue(input.robots),
  structuredData: resolveSeoValue(input.structuredData),
  meta: resolveSeoValue(input.meta),
  links: resolveSeoValue(input.links),
})

const mergeDefined = <T extends Record<string, unknown>>(
  base: T,
  override: T | undefined
): T => {
  if (!override) return base
  const merged = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value
  }
  return merged
}

export const mergeSeoInput = (base: SeoInput, override: SeoInput): SeoInput => {
  const merged: SeoInput = {
    ...base,
    openGraph: mergeDefined(base.openGraph ?? {}, override.openGraph),
    twitter: mergeDefined(base.twitter ?? {}, override.twitter),
    robots: mergeDefined(base.robots ?? {}, override.robots),
    meta: override.meta ?? base.meta,
    links: override.links ?? base.links,
    structuredData: override.structuredData ?? base.structuredData,
  }
  const scalars: Array<keyof SeoInput> = [
    'title',
    'description',
    'image',
    'canonical',
    'index',
    'follow',
  ]
  for (const key of scalars) {
    const value = override[key]
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value
  }
  return merged
}

const applicationSeoInput = (config: SeoApplicationConfig): SeoInput => ({
  title: config.title,
  description: config.description,
  image: config.image,
  canonical: config.canonical,
  index: config.index,
  follow: config.follow,
  openGraph: config.openGraph,
  twitter: config.twitter,
  robots: config.robots,
  structuredData: config.structuredData,
  meta: config.meta,
  links: config.links,
})

export const mergeSeoLayers = (
  state: SeoState,
  routeSeo: SeoInput | undefined
): SeoInput => {
  let merged = applicationSeoInput(state.config)
  if (routeSeo) merged = mergeSeoInput(merged, routeSeo)
  for (const layer of state.layers) {
    if (!layer.active) continue
    merged = mergeSeoInput(merged, resolveUseSeoInput(layer.input))
  }
  return merged
}

export const registerSeoLayer = (
  state: SeoState,
  input: UseSeoInput
): SeoLayer => {
  const layer: SeoLayer = {
    id: state.nextLayerId,
    active: true,
    input,
  }
  state.nextLayerId += 1
  state.layers.push(layer)
  return layer
}

export const removeSeoLayer = (state: SeoState, layer: SeoLayer): void => {
  const index = state.layers.indexOf(layer)
  if (index >= 0) state.layers.splice(index, 1)
}
