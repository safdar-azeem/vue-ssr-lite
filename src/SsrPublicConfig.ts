import { useSsrRequestContext } from './SsrRequestContext'
import type { SsrPublicConfigFactory, SsrPublicConfigSource } from './SsrConfigTypes'
import type { SsrPublicConfigRequest } from './SsrRuntimeTypes'

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const cloneJsonSafe = (value: unknown, path: string, ancestors: WeakSet<object>): unknown => {
  if (value === undefined) {
    throw new Error(`[vue-ssr-lite] ${path} contains undefined, which cannot be serialized exactly.`)
  }
  if (value === null) return value
  const type = typeof value
  if (type === 'function') {
    throw new Error(`[vue-ssr-lite] ${path} contains a function, which cannot be serialized.`)
  }
  if (type === 'symbol') {
    throw new Error(`[vue-ssr-lite] ${path} contains a symbol, which cannot be serialized.`)
  }
  if (type === 'bigint') {
    throw new Error(`[vue-ssr-lite] ${path} contains a bigint, which cannot be serialized.`)
  }
  if (type === 'number') {
    const number = value as number
    if (!Number.isFinite(number)) {
      throw new Error(
        `[vue-ssr-lite] ${path} contains a non-finite number, which cannot be serialized exactly.`
      )
    }
    return Object.is(number, -0) ? 0 : number
  }
  if (type !== 'object') return value
  const object = value as object
  if (ancestors.has(object)) {
    throw new Error(`[vue-ssr-lite] ${path} contains a circular reference.`)
  }
  ancestors.add(object)
  try {
    if (Array.isArray(value)) {
      const snapshot: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new Error(
            `[vue-ssr-lite] ${path} contains a sparse array slot at index ${index}, which cannot be serialized exactly.`
          )
        }
        snapshot.push(cloneJsonSafe(value[index], `${path}[${index}]`, ancestors))
      }
      return Object.freeze(snapshot)
    }
    if (!isPlainObject(object)) {
      throw new Error(`[vue-ssr-lite] ${path} contains a non-serializable value.`)
    }
    return Object.freeze(
      Object.fromEntries(
        Object.entries(object).map(([key, nested]) => [
          key,
          cloneJsonSafe(nested, `${path}.${key}`, ancestors),
        ])
      )
    )
  } finally {
    ancestors.delete(object)
  }
}

/** Reject values that cannot be safely transported through hydration JSON. */
export const assertPublicConfigSerializable = <T>(value: T, label = 'publicConfig'): T => {
  cloneJsonSafe(value, label, new WeakSet())
  return value
}

/** Create the request-owned immutable value used by rendering and cache identity. */
export const snapshotPublicConfig = <T>(value: T, label = 'publicConfig'): T =>
  cloneJsonSafe(value, label, new WeakSet()) as T

export const resolvePublicConfigValue = async (
  source: SsrPublicConfigSource | undefined,
  request: SsrPublicConfigRequest
): Promise<Record<string, unknown>> => {
  if (source === undefined) return snapshotPublicConfig({})
  const resolved =
    typeof source === 'function' ? await (source as SsrPublicConfigFactory)(request) : source
  const snapshot = snapshotPublicConfig(resolved)
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('[vue-ssr-lite] publicConfig must resolve to a plain object.')
  }
  return snapshot as Record<string, unknown>
}

export const usePublicConfig = <T = unknown>(): T =>
  useSsrRequestContext<Record<string, unknown>, T>().publicConfig
