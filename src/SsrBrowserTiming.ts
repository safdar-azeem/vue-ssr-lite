import type { SsrHydrationContext } from './SsrHydrationRuntime'

/** Internal profiler hook. No observer, marks, timers or retained samples by default. */
export type SsrBrowserPhase = 'hydrate-start' | 'spa-start' | 'application-ready' |
  'router-ready' | 'mount-start' | 'hydrate-complete' | 'spa-mounted' | 'first-idle'

type TimingObserver = (sample: { applicationId: string; phase: string; time: number }) => void
const key = Symbol.for('vue-ssr-lite:browser-timing')

export const markSsrBrowserPhase = (applicationId: string, phase: SsrBrowserPhase): void => {
  try {
    const observer = (globalThis as typeof globalThis & Record<symbol, unknown>)[key]
    if (typeof observer === 'function') {
      const receive = observer as TimingObserver
      receive({ applicationId, phase, time: performance.now() })
    }
  } catch {
    // Profiling must never change hydration, routing or failure semantics.
  }
}

/** A scheduling observation, not a claim that all application work is finished. */
export const markSsrBrowserIdle = (
  applicationId: string,
  signal: AbortSignal,
  hydration?: Pick<SsrHydrationContext, 'onDispose'>
): void => {
  try {
    if (typeof (globalThis as typeof globalThis & Record<symbol, unknown>)[key] !== 'function' || signal.aborted) return
    // Do not substitute a timer and label it idle on browsers without this API.
    if (typeof requestIdleCallback !== 'function') return
    const cancel = () => cancelIdleCallback(handle)
    const handle = requestIdleCallback(() => {
      signal.removeEventListener('abort', cancel)
      if (!signal.aborted) markSsrBrowserPhase(applicationId, 'first-idle')
    })
    signal.addEventListener('abort', cancel, { once: true })
    hydration?.onDispose(() => {
      cancel()
      signal.removeEventListener('abort', cancel)
    })
  } catch {
    // Optional browser profiling only.
  }
}
