import { toRaw } from 'vue'
import { createMemoryHistory, createWebHistory } from 'vue-router'
import { createSsrApplicationCore, type SsrApplicationHost, type SsrCreateApplicationOptions } from './SsrApplicationCore'
import { createSsrResolutionController } from './SsrServerResolution'
import { fingerprintSsrReconciliationState } from './SsrReconciliationFingerprint'
import { installSsrRequestContextObservation, unwrapSsrRequestObservation } from './SsrRequestObservation'
import type { SsrResolvedApplicationDefinition } from './SsrRuntimeTypes'

export type { SsrCreateApplicationOptions } from './SsrApplicationCore'

const serverHost: SsrApplicationHost = {
  createHistory: createMemoryHistory,
  createResolution: () => createSsrResolutionController(true),
  observe: ({ context, hydration, managedHead, resolution }) => {
    installSsrRequestContextObservation(context)
    resolution.setReactivityCheckpointReader(() => fingerprintSsrReconciliationState({
      application: context.state,
      plugins: hydration.collect(false),
      head: managedHead.collect(),
      response: context.response,
    }, unwrapSsrRequestObservation))
  },
}

// Retain the internal universal entry for existing tests and server integrations.
const universalBrowserHost: SsrApplicationHost = {
  createHistory: createWebHistory,
  createResolution: () => createSsrResolutionController(false),
}

/** Universal internal entry; browser bootstrap imports the core directly. */
export const createSsrApplication = <
  TApplicationState extends Record<string, any> = Record<string, unknown>,
  TPublicConfig = unknown,
>(
  definition: SsrResolvedApplicationDefinition<TApplicationState, TPublicConfig>,
  options: SsrCreateApplicationOptions<TApplicationState, TPublicConfig>
) => createSsrApplicationCore(definition, options, options.server ? serverHost : universalBrowserHost)

const cloneReconciliationValue = (value: unknown, seen: WeakMap<object, unknown>): unknown => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
  if (typeof value === 'function') return value
  const raw = toRaw(unwrapSsrRequestObservation(value))
  const existing = seen.get(raw)
  if (existing !== undefined) return existing
  if (raw instanceof Date) return new Date(raw.getTime())
  if (raw instanceof RegExp) return new RegExp(raw.source, raw.flags)
  if (raw instanceof Map) {
    const cloned = new Map()
    seen.set(raw, cloned)
    for (const [key, entry] of raw) cloned.set(cloneReconciliationValue(key, seen), cloneReconciliationValue(entry, seen))
    return cloned
  }
  if (raw instanceof Set) {
    const cloned = new Set()
    seen.set(raw, cloned)
    for (const entry of raw) cloned.add(cloneReconciliationValue(entry, seen))
    return cloned
  }
  const cloned: Record<PropertyKey, unknown> | unknown[] = Array.isArray(raw)
    ? [] : Object.create(Object.getPrototypeOf(raw))
  seen.set(raw, cloned)
  for (const key of Reflect.ownKeys(raw)) {
    if (Array.isArray(raw) && key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)
    if (!descriptor) continue
    if ('value' in descriptor) descriptor.value = cloneReconciliationValue(descriptor.value, seen)
    Object.defineProperty(cloned, key, descriptor)
  }
  return cloned
}

/** Request-local snapshots retain descriptors, collections and circular ownership. */
export const snapshotSsrReconciliationState = <T>(value: T): T =>
  cloneReconciliationValue(value, new WeakMap()) as T
