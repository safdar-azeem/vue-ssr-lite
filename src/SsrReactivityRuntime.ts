import {
  watch,
  watchEffect,
  type WatchCallback,
  type WatchOptions,
  type WatchSource,
  type WatchStopHandle,
} from 'vue'

/**
 * SSR-safe reactivity.
 *
 * # Which Vue reactivity APIs are server-safe
 *
 * During server-side rendering Vue does NOT flush the scheduler, so any effect
 * queued to run later is created and then discarded. This is the single most
 * common cause of "the shell renders but the content is missing" bugs.
 *
 * | API                                   | Server behaviour                                   |
 * | ------------------------------------- | -------------------------------------------------- |
 * | `computed`                            | ✅ Safe. Lazily evaluated during render.           |
 * | `watch(src, cb, { flush: 'sync' })`   | ✅ Safe. Runs synchronously, stays active in render.|
 * | `watch(src, cb)` / `{ flush:'pre' }`  | ⚠️  Discarded. `immediate` runs once, then nothing.|
 * | `watch(src, cb, { flush: 'post' })`   | ⚠️  Discarded. Never runs on the server.           |
 * | `watchEffect(fn)`                      | ⚠️  Runs once at setup, then discarded.            |
 * | `onServerPrefetch(async fn)`          | ✅ Safe. Awaited before the component renders.      |
 * | `onMounted` / `onUpdated`             | ❌ Browser only. Never runs on the server.         |
 *
 * # The primitive
 *
 * {@link ssrWatch} and {@link ssrWatchEffect} force `flush: 'sync'`, so the
 * effect is active during the server render and reacts to state that settles
 * mid-render (for example a ref written by an awaited `onServerPrefetch`). They
 * behave identically on the server and in the browser, which is exactly what an
 * application needs to derive state from resolved data without reinventing a
 * broken watcher workaround.
 *
 * Prefer a `computed` when you only need to DERIVE a value for the template.
 * Reach for {@link ssrWatch} when resolved data must drive an imperative side
 * effect (populating an external store, setting a status code) that has to
 * happen during the server render.
 */

export type SsrWatchOptions<Immediate extends boolean = boolean> = Omit<
  WatchOptions<Immediate>,
  'flush'
>

/**
 * `watch`, pinned to `flush: 'sync'` so the callback is active during SSR.
 *
 * Identical semantics to Vue's `watch` otherwise: pass `{ immediate: true }` to
 * run once on setup, and use the returned handle to stop it. Because the flush
 * is synchronous, avoid mutating the watched source from inside the callback.
 */
export function ssrWatch<T, Immediate extends boolean = false>(
  source: WatchSource<T>,
  callback: WatchCallback<T, Immediate extends true ? T | undefined : T>,
  options?: SsrWatchOptions<Immediate>
): WatchStopHandle
export function ssrWatch<T extends readonly unknown[], Immediate extends boolean = false>(
  source: readonly [...T] | (() => T),
  callback: WatchCallback<T, Immediate extends true ? T | undefined : T>,
  options?: SsrWatchOptions<Immediate>
): WatchStopHandle
export function ssrWatch(
  source: any,
  callback: any,
  options?: SsrWatchOptions
): WatchStopHandle {
  return watch(source, callback, { ...options, flush: 'sync' })
}

/**
 * `watchEffect`, pinned to `flush: 'sync'` so the effect is active during SSR.
 * The effect runs immediately and re-runs synchronously whenever a tracked
 * dependency changes — including changes that happen while the server render is
 * still in progress.
 */
export const ssrWatchEffect = (
  effect: Parameters<typeof watchEffect>[0],
  options?: Omit<NonNullable<Parameters<typeof watchEffect>[1]>, 'flush'>
): WatchStopHandle => watchEffect(effect, { ...options, flush: 'sync' })
