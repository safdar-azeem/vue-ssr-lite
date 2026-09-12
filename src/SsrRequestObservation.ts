import { fingerprintSsrReconciliationState } from './SsrReconciliationFingerprint'
import type { SsrRequestResolution } from './SsrRequestResolution'
import type { SsrRequestContext } from './SsrRuntimeTypes'

interface ObservationResolution extends SsrRequestResolution {
  registerReactivityObservation?(
    observed: string | null,
    readTerminal: () => string | null
  ): void
}

const observationTargets = new WeakMap<object, object>()

/** Internal removal of the transparent request-observation wrapper. */
export const unwrapSsrRequestObservation = <T>(value: T): T =>
  value !== null && typeof value === 'object'
    ? ((observationTargets.get(value) ?? value) as T)
    : value

const isObservationContainer = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value)
  return (
    Array.isArray(value) ||
    value instanceof Map ||
    value instanceof Set ||
    prototype === Object.prototype ||
    prototype === null
  )
}

const projectPropertyDescriptor = (
  descriptor: PropertyDescriptor | undefined
): unknown =>
  // Structural algorithms consume descriptor shape without reading a data
  // value or accessor references. Direct `.value`/`.get`/`.set` consumption is
  // outside the v1 automatic contract and requires an explicit pass.
  descriptor
    ? {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        kind: 'value' in descriptor ? 'value' : 'accessor',
        writable: 'writable' in descriptor ? descriptor.writable : undefined,
      }
    : undefined

const observeRequestValue = <T>(
  value: T,
  observe: (
    value: unknown,
    readTerminal: () => unknown,
    includeContainerContents?: boolean
  ) => void,
  proxies: WeakMap<object, object>
): T => {
  if (
    value === null ||
    typeof value !== 'object' ||
    !isObservationContainer(value)
  ) {
    return value
  }
  const existing = proxies.get(value)
  if (existing) return existing as T
  const proxy = new Proxy(value, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key.startsWith('__v_')) {
        return Reflect.get(target, key, target)
      }
      if (target instanceof Map) {
        if (key === 'get') {
          return (mapKey: unknown) => {
            const rawKey = unwrapSsrRequestObservation(mapKey)
            const result = target.get(rawKey)
            observe(result, () => target.get(rawKey))
            return observeRequestValue(result, observe, proxies)
          }
        }
        if (key === 'has') {
          return (mapKey: unknown) => {
            const rawKey = unwrapSsrRequestObservation(mapKey)
            const result = target.has(rawKey)
            observe(result, () => target.has(rawKey))
            return result
          }
        }
        if (key === 'set') {
          return (mapKey: unknown, entry: unknown) => {
            const rawKey = unwrapSsrRequestObservation(mapKey)
            const rawEntry = unwrapSsrRequestObservation(entry)
            target.set(rawKey, rawEntry)
            return receiver
          }
        }
        if (key === 'delete') {
          return (mapKey: unknown) => {
            const deleted = target.delete(unwrapSsrRequestObservation(mapKey))
            return deleted
          }
        }
        if (key === 'clear') {
          return () => {
            target.clear()
          }
        }
        if (key === 'forEach') {
          return (
            callback: (entry: unknown, mapKey: unknown, map: unknown) => void,
            thisArg?: unknown
          ) => {
            let index = 0
            const readAt = (entryIndex: number) =>
              [...target.entries()][entryIndex]
            target.forEach((entry, mapKey) => {
              const entryIndex = index
              index += 1
              observe(mapKey, () => readAt(entryIndex)?.[0])
              observe(entry, () => readAt(entryIndex)?.[1])
              callback.call(
                thisArg,
                observeRequestValue(entry, observe, proxies),
                observeRequestValue(mapKey, observe, proxies),
                receiver
              )
            })
            observe(index, () => target.size)
          }
        }
        if (
          key === Symbol.iterator ||
          key === 'entries' ||
          key === 'keys' ||
          key === 'values'
        ) {
          return () => {
            // A lazy iterator depends only on results exposed by `next()`, not
            // on unconsumed entries later in the collection.
            const createIterator = () =>
              key === 'keys'
                ? target.keys()
                : key === 'values'
                  ? target.values()
                  : target.entries()
            const iterator = createIterator()
            let index = 0
            const readAt = (entryIndex: number) => {
              const terminalIterator = createIterator()
              let result = terminalIterator.next()
              for (let current = 0; current < entryIndex; current += 1) {
                if (result.done) return result
                result = terminalIterator.next()
              }
              return result
            }
            return {
              next() {
                const result = iterator.next()
                const entryIndex = index
                index += 1
                observe(result.done, () => readAt(entryIndex).done)
                if (result.done) return result
                if (key === 'keys' || key === 'values') {
                  observe(result.value, () => readAt(entryIndex).value)
                  return {
                    done: false,
                    value: observeRequestValue(result.value, observe, proxies),
                  }
                }
                observe(result.value[0], () => readAt(entryIndex).value[0])
                observe(result.value[1], () => readAt(entryIndex).value[1])
                return {
                  done: false,
                  value: [
                    observeRequestValue(result.value[0], observe, proxies),
                    observeRequestValue(result.value[1], observe, proxies),
                  ],
                }
              },
              [Symbol.iterator]() {
                return this
              },
            }
          }
        }
        const result = Reflect.get(target, key, target)
        observe(result, () => Reflect.get(target, key, target))
        return result
      }
      if (target instanceof Set) {
        if (key === 'has') {
          return (entry: unknown) => {
            const rawEntry = unwrapSsrRequestObservation(entry)
            const result = target.has(rawEntry)
            observe(result, () => target.has(rawEntry))
            return result
          }
        }
        if (key === 'add') {
          return (entry: unknown) => {
            const rawEntry = unwrapSsrRequestObservation(entry)
            target.add(rawEntry)
            return receiver
          }
        }
        if (key === 'delete') {
          return (entry: unknown) => {
            const deleted = target.delete(unwrapSsrRequestObservation(entry))
            return deleted
          }
        }
        if (key === 'clear') {
          return () => {
            target.clear()
          }
        }
        if (key === 'forEach') {
          return (
            callback: (entry: unknown, duplicate: unknown, set: unknown) => void,
            thisArg?: unknown
          ) => {
            let index = 0
            const readAt = (entryIndex: number) =>
              [...target.values()][entryIndex]
            target.forEach((entry) => {
              const entryIndex = index
              index += 1
              observe(entry, () => readAt(entryIndex))
              const observed = observeRequestValue(entry, observe, proxies)
              callback.call(thisArg, observed, observed, receiver)
            })
            observe(index, () => target.size)
          }
        }
        if (
          key === Symbol.iterator ||
          key === 'entries' ||
          key === 'keys' ||
          key === 'values'
        ) {
          return () => {
            // Match the Map contract: observe yielded results by ordinal and
            // leave unconsumed Set entries outside the dependency surface.
            const createIterator = () => target.values()
            const iterator = createIterator()
            let index = 0
            const readAt = (entryIndex: number) => {
              const terminalIterator = createIterator()
              let result = terminalIterator.next()
              for (let current = 0; current < entryIndex; current += 1) {
                if (result.done) return result
                result = terminalIterator.next()
              }
              return result
            }
            return {
              next() {
                const result = iterator.next()
                const entryIndex = index
                index += 1
                observe(result.done, () => readAt(entryIndex).done)
                if (result.done) return result
                observe(result.value, () => readAt(entryIndex).value)
                const observed = observeRequestValue(
                  result.value,
                  observe,
                  proxies
                )
                return {
                  done: false,
                  value: key === 'entries' ? [observed, observed] : observed,
                }
              },
              [Symbol.iterator]() {
                return this
              },
            }
          }
        }
        const result = Reflect.get(target, key, target)
        observe(result, () => Reflect.get(target, key, target))
        return result
      }
      const nested = Reflect.get(target, key, receiver)
      observe(nested, () => Reflect.get(target, key, target))
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
      if (
        descriptor &&
        'value' in descriptor &&
        descriptor.configurable === false &&
        descriptor.writable === false
      ) {
        return nested
      }
      return observeRequestValue(nested, observe, proxies)
    },
    has(target, key) {
      const result = Reflect.has(target, key)
      if (!(typeof key === 'string' && key.startsWith('__v_'))) {
        observe(result, () => Reflect.has(target, key))
      }
      return result
    },
    ownKeys(target) {
      const result = Reflect.ownKeys(target)
      observe(result, () => Reflect.ownKeys(target), true)
      return result
    },
    getOwnPropertyDescriptor(target, key) {
      const result = Reflect.getOwnPropertyDescriptor(target, key)
      if (!(typeof key === 'string' && key.startsWith('__v_'))) {
        observe(
          projectPropertyDescriptor(result),
          () =>
            projectPropertyDescriptor(
              Reflect.getOwnPropertyDescriptor(target, key)
            ),
          true
        )
      }
      return result
    },
    set(target, key, next) {
      const rawNext = unwrapSsrRequestObservation(next)
      return Reflect.set(target, key, rawNext, target)
    },
    deleteProperty(target, key) {
      return Reflect.deleteProperty(target, key)
    },
    defineProperty(target, key, descriptor) {
      return Reflect.defineProperty(target, key, descriptor)
    },
  })
  proxies.set(value, proxy)
  observationTargets.set(proxy, value)
  return proxy as T
}

/** Internal request-owned observation installation for the server runtime. */
export const installSsrRequestContextObservation = <
  TApplicationState,
  TPublicConfig,
>(context: SsrRequestContext<TApplicationState, TPublicConfig>): void => {
  const resolution = context.resolution as ObservationResolution
  if (!resolution.server || !resolution.registerReactivityObservation) return
  const fingerprint = (value: unknown): string | null => {
    try {
      return fingerprintSsrReconciliationState(value)
    } catch {
      return null
    }
  }
  const containerReferences = new WeakMap<object, number>()
  let nextContainerReference = 0
  const containerReference = (value: object): number => {
    const existing = containerReferences.get(value)
    if (existing !== undefined) return existing
    const reference = nextContainerReference
    nextContainerReference += 1
    containerReferences.set(value, reference)
    return reference
  }
  const projectDependency = (
    value: unknown,
    includeContainerContents: boolean
  ): unknown => {
    if (
      includeContainerContents ||
      value === null ||
      typeof value !== 'object' ||
      !isObservationContainer(value)
    ) {
      return value
    }
    const kind = Array.isArray(value)
      ? 'array'
      : value instanceof Map
        ? 'map'
        : value instanceof Set
          ? 'set'
          : 'object'
    return ['container-reference', kind, containerReference(value)]
  }
  const observe = (
    value: unknown,
    readTerminal: () => unknown,
    includeContainerContents = false
  ) =>
    resolution.registerReactivityObservation?.(
      fingerprint(projectDependency(value, includeContainerContents)),
      () =>
        fingerprint(
          projectDependency(readTerminal(), includeContainerContents)
        )
    )
  const proxies = new WeakMap<object, object>()
  context.state = observeRequestValue(context.state, observe, proxies)
  context.response = observeRequestValue(context.response, observe, proxies)
}
