import {
  getCurrentInstance,
  inject,
  onScopeDispose,
  onServerPrefetch,
  shallowReadonly,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type ShallowRef,
} from 'vue'
import { SSR_FETCH_RUNTIME } from '../runtime/SsrFetchRuntime'
import type {
  UseFetchOptions,
  UseFetchOptionsBase,
  UseFetchOptionsParameter,
  UseFetchResult,
  UseFetchReturn,
  UseFetchVariables,
} from '../types/SsrFetchTypes'

export function useFetch<TData = unknown, TVariables extends object = UseFetchVariables>(
  url: MaybeRefOrGetter<string | URL>,
  ...parameters: UseFetchOptionsParameter<TData, TVariables>
): UseFetchResult<TData> {
  const instance = getCurrentInstance()
  const runtime = instance ? inject(SSR_FETCH_RUNTIME, null) : null
  if (!instance || !runtime) {
    throw new Error('useFetch() must run synchronously from component setup() or <script setup> in an active vue-ssr-lite application.')
  }
  const options = (parameters[0] ?? {}) as UseFetchOptions<TData, TVariables>
  // Erasure stays at this boundary; the public signature preserves concrete data
  // and required variable shapes, while entries share unknown transport values.
  const internalOptions = options as unknown as UseFetchOptionsBase<unknown, object>
  const identity = () => runtime.resolve(toValue(url), toValue(options.variables), internalOptions)
  const consumer = runtime.createConsumer(identity(), internalOptions, (error) => {
    try {
      if (instance.appContext.config.errorHandler) {
        instance.appContext.config.errorHandler(error, instance.proxy, 'useFetch execution')
      } else {
        console.error('[vue-ssr-lite] useFetch execution observer failed', error)
      }
    } catch {
      // An application's error reporter must not break request settlement either.
    }
  })
  onScopeDispose(() => runtime.release(consumer))

  // Create P *before* registering prefetch. Async setup can await P immediately
  // without waiting for Vue to reach a prefetch phase that needs setup to finish.
  const initial = runtime.initialize(consumer)
  if (runtime.server) onServerPrefetch(() => initial)

  try {
    consumer.stop = watch(identity, (next) => {
      if (!runtime.move(consumer, next)) return
      const execution = runtime.automatic(consumer)
      if (runtime.server && options.immediate !== false && options.server !== false) {
        runtime.context.resolution.track(execution.then(() => runtime.context.resolution.requestAdditionalPass()))
      }
    }, { flush: 'sync' })
    if (consumer.disposed) consumer.stop()
  } catch (error) {
    runtime.release(consumer)
    throw error
  }

  const base: UseFetchReturn<TData> = {
    data: consumer.data as ShallowRef<TData | undefined>,
    pending: shallowReadonly(consumer.pending),
    error: shallowReadonly(consumer.error),
    refresh: () => {
      try {
        runtime.move(consumer, identity())
        return runtime.refresh(consumer)
      } catch (error) {
        return Promise.reject(error)
      }
    },
  }
  // Fixed for this hook's lifetime. Never resolve with the public thenable.
  const ready = runtime.server ? initial.then(() => base) : Promise.resolve(base)
  return { ...base, then: (fulfilled, rejected) => ready.then(fulfilled, rejected) }
}
