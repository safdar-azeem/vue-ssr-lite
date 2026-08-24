import { useSsrRequestContext } from './SsrRequestContext'

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const walkJsonSafe = (
  value: unknown,
  path: string,
  ancestors: WeakSet<object>
): void => {
  if (value == null) return
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
  if (type !== 'object') return
  const object = value as object
  if (ancestors.has(object)) {
    throw new Error(`[vue-ssr-lite] ${path} contains a circular reference.`)
  }
  ancestors.add(object)
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        walkJsonSafe(item, `${path}[${index}]`, ancestors)
      )
      return
    }
    if (!isPlainObject(object)) {
      throw new Error(
        `[vue-ssr-lite] ${path} contains a non-serializable value.`
      )
    }
    for (const [key, nested] of Object.entries(object)) {
      walkJsonSafe(nested, `${path}.${key}`, ancestors)
    }
  } finally {
    ancestors.delete(object)
  }
}

/** Reject values that cannot be safely transported through hydration JSON. */
export const assertPublicConfigSerializable = <T>(
  value: T,
  label = 'publicConfig'
): T => {
  walkJsonSafe(value, label, new WeakSet())
  return value
}

export const resolvePublicConfigValue = async (
  source: unknown
): Promise<unknown> => {
  const resolved = typeof source === 'function' ? await source() : source
  return assertPublicConfigSerializable(resolved ?? {})
}

export const usePublicConfig = <T = unknown>(): T =>
  useSsrRequestContext<Record<string, unknown>, T>().publicConfig
