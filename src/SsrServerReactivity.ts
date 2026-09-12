import { getCurrentInstance, watch, watchEffect } from 'vue'
import type { SsrRequestResolution, SsrResolutionController, SsrReactivitySource, SsrServerReactivity } from './SsrRequestResolution'

export const registerSsrReactivitySource = (
  resolution: SsrRequestResolution,
  identity?: string,
  deduplicable?: boolean
): SsrReactivitySource | null => {
  const controller = resolution as Partial<SsrResolutionController>
  return typeof controller.registerReactivitySource === 'function'
    ? controller.registerReactivitySource(identity, deduplicable)
    : null
}

const normalizeExactValue = (
  value: unknown,
  ancestors: WeakSet<object>
): unknown | null => {
  if (value === null) return ['null']
  if (value === undefined) return ['undefined']
  if (typeof value === 'string') return ['string', value]
  if (typeof value === 'boolean') return ['boolean', value]
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['number', 'NaN']
    if (value === Infinity) return ['number', 'Infinity']
    if (value === -Infinity) return ['number', '-Infinity']
    if (Object.is(value, -0)) return ['number', '-0']
    return ['number', value]
  }
  if (typeof value === 'bigint') return ['bigint', String(value)]
  if (typeof value !== 'object') return null
  if (ancestors.has(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return null
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value)
      if (
        ownKeys.some(
          (key) =>
            typeof key === 'symbol' ||
            (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))
        )
      ) {
        return null
      }
      const items: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) return null
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !('value' in descriptor)) return null
        const normalized = normalizeExactValue(descriptor.value, ancestors)
        if (normalized === null) return null
        items.push(normalized)
      }
      return ['array', items]
    }
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some((key) => typeof key === 'symbol')) return null
    const entries: unknown[] = []
    for (const key of (ownKeys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) return null
      const normalized = normalizeExactValue(
        descriptor.value,
        ancestors
      )
      if (normalized === null) return null
      entries.push([
        key,
        descriptor.enumerable,
        descriptor.configurable,
        descriptor.writable,
        normalized,
      ])
    }
    return ['object', entries]
  } finally {
    ancestors.delete(value)
  }
}

export const fingerprintSsrReactivityValues = (
  values: readonly unknown[]
): string | null => {
  try {
    const normalized = normalizeExactValue(values, new WeakSet())
    return normalized === null ? null : JSON.stringify(normalized)
  } catch {
    return null
  }
}

/**
 * Internal bridge used by `ssrWatch` and `ssrWatchEffect`. Recreated instances
 * are coalesced directly only when both source ownership and transition values
 * are exact. Ambiguous callbacks consume the prior pass's ordered group
 * obligations. Pass completion also accounts for inherited obligations that
 * did not recur and request-state observations around every automatic
 * reactivity callback, using adjacent request-state checkpoints rather than
 * blind ordering or raw callback-count equality.
 */
export const requestSsrReactivityPass = (
  resolution: SsrRequestResolution,
  source: SsrReactivitySource | null,
  values: readonly unknown[] | null,
  beforeCheckpoint?: string | null
): void => {
  const controller = resolution as Partial<SsrResolutionController>
  if (source && typeof controller.requestReactivityPass === 'function') {
    controller.requestReactivityPass(
      source,
      values === null ? null : fingerprintSsrReactivityValues(values),
      beforeCheckpoint
    )
    return
  }
  resolution.requestAdditionalPass()
}

export const requestSsrReactivityEffectPass = (
  resolution: SsrRequestResolution,
  source: SsrReactivitySource | null
): void => {
  const controller = resolution as Partial<SsrResolutionController>
  if (source && typeof controller.requestReactivityEffectPass === 'function') {
    controller.requestReactivityEffectPass(source)
    return
  }
  resolution.requestAdditionalPass()
}

const runSsrReactivityCallback = <T>(
  resolution: SsrRequestResolution | null,
  callback: () => T
): T => {
  const controller = resolution as Partial<SsrResolutionController> | null
  controller?.beginReactivityCallback?.()
  try {
    return callback()
  } finally {
    controller?.endReactivityCallback?.()
  }
}

const resolveComponentTypeIdentity = (type: {
  name?: string
  __name?: string
  __file?: string
  __scopeId?: string
  setup?: unknown
  render?: unknown
}): string => {
  const label = type.__file || type.__scopeId || type.name || type.__name || 'anonymous'
  const implementation =
    typeof type === 'function'
      ? String(type)
      : typeof type.setup === 'function'
      ? String(type.setup)
      : typeof type.render === 'function'
        ? String(type.render)
        : ''
  return JSON.stringify([label, implementation])
}

const resolveReactivityIdentity = (): {
  identity: string
  deduplicable: boolean
} => {
  const segments: string[] = []
  let instance = getCurrentInstance()
  let deduplicable = true
  while (instance) {
    const type = instance.type as {
      name?: string
      __name?: string
      __file?: string
      __scopeId?: string
      setup?: unknown
      render?: unknown
    }
    const typeIdentity = resolveComponentTypeIdentity(type)
    const key = instance.vnode.key
    const props = fingerprintSsrReactivityValues([instance.vnode.props ?? {}])
    const root = instance.parent === null
    // An unkeyed non-root instance can exchange structural position with a
    // sibling on a later pass. Its invalidations remain conservatively eligible
    // rather than relying on traversal order or props to prove identity.
    if (!root && key == null) deduplicable = false
    if (props === null) deduplicable = false
    segments.push(
      `${typeIdentity}:${key == null ? '' : String(key)}:${props ?? 'uncertain'}`
    )
    instance = instance.parent
  }
  return {
    identity: segments.reverse().join('/') || 'anonymous',
    deduplicable,
  }
}


const watchSsrSource: SsrServerReactivity['watch'] = (resolution, source, callback, options) => {
  const { identity, deduplicable } = resolveReactivityIdentity()
  const reactivitySource =
    resolution?.server
      ? registerSsrReactivitySource(resolution, identity, deduplicable)
      : null
  let created = false
  const wrapped = (...args: any[]) => {
    const controller = resolution as Partial<SsrResolutionController> | null
    const beforeCheckpoint =
      created && resolution?.server
        ? controller?.reactivityCheckpoint?.()
        : undefined
    const result = runSsrReactivityCallback(resolution, () => callback(...args))
    if (created && resolution?.server) {
      requestSsrReactivityPass(
        resolution,
        reactivitySource,
        args.slice(0, 2),
        beforeCheckpoint
      )
    }
    return result
  }
  const stop = watch(source, wrapped, { ...options, flush: 'sync' })
  created = true
  return stop
}

const watchSsrEffect: SsrServerReactivity['watchEffect'] = (resolution, effect, options) => {
  const { identity, deduplicable } = resolveReactivityIdentity()
  const reactivitySource =
    resolution?.server
      ? registerSsrReactivitySource(resolution, identity, deduplicable)
      : null
  let created = false
  const stop = watchEffect(
    ((onCleanup: any) => {
      const result = runSsrReactivityCallback(resolution, () =>
        (effect as any)(onCleanup)
      )
      if (created && resolution?.server) {
        requestSsrReactivityEffectPass(resolution, reactivitySource)
      }
      return result
    }) as Parameters<typeof watchEffect>[0],
    { ...options, flush: 'sync' }
  )
  created = true
  return stop
}

/** Stateless implementation; each invocation receives its owning request controller. */
export const serverReactivity: SsrServerReactivity = { watch: watchSsrSource, watchEffect: watchSsrEffect }
