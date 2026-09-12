// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://performance.test/"}
import { createApp, defineComponent, h, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSpaApplication } from './SsrBrowserRuntime'
import { createSsrBrowserResolution } from './SsrBrowserResolution'
import { SSR_REQUEST_RESOLUTION } from './SsrRequestResolution'
import * as resolutionRuntime from './SsrServerReactivity'
import { ssrWatch, ssrWatchEffect } from './SsrReactivityRuntime'
import { createSsrHydrationController } from './SsrHydrationRuntime'
import { markSsrBrowserIdle, markSsrBrowserPhase } from './SsrBrowserTiming'
import { createTestDomain } from './SsrTestFixtures'

const timingKey = Symbol.for('vue-ssr-lite:browser-timing')
const profiler = globalThis as typeof globalThis & Record<symbol, unknown>

afterEach(() => {
  delete profiler[timingKey]
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('browser bootstrap performance contracts', () => {
  it('keeps browser resolution inert and preserves promise identity', async () => {
    const resolution = createSsrBrowserResolution()
    const promise = Promise.resolve('value')
    expect(resolution.track(promise)).toBe(promise)
    resolution.requestAdditionalPass()
    resolution.setReactivityCheckpointReader(() => { throw new Error('server checkpoint') })
    expect(resolution.reactivityCheckpoint()).toBeNull()
    expect(resolution.additionalPassRequested()).toBe(false)
    expect(resolution.pendingWork()).toEqual([])
    expect(await resolution.drain(1)).toBe(true)
    resolution.dispose()
    expect(resolution.track(promise)).toBe(promise)
  })

  it('runs synchronous browser watchers without fingerprinting component ancestors', () => {
    const fingerprint = vi.spyOn(resolutionRuntime, 'fingerprintSsrReactivityValues')
    const value = ref(0)
    const callback = vi.fn()
    const cleanup = vi.fn()
    const effect = vi.fn()
    const app = createApp(defineComponent({
      setup() {
        ssrWatch(value, (current, previous, onCleanup) => {
          callback(current, previous)
          onCleanup(cleanup)
        })
        ssrWatchEffect(() => { effect(value.value) })
        return () => h('main', String(value.value))
      },
    }))
    app.provide(SSR_REQUEST_RESOLUTION, createSsrBrowserResolution())
    const root = document.createElement('div')
    document.body.append(root)
    app.mount(root)
    try {
      value.value = 1
      expect(callback).toHaveBeenCalledWith(1, 0)
      expect(effect).toHaveBeenLastCalledWith(1)
      expect(fingerprint).not.toHaveBeenCalled()
    } finally { app.unmount() }
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('keeps restored state owned and ignores server contributors in the browser', () => {
    const restored = { feature: { value: 1 } }
    const hydration = createSsrHydrationController(restored, false, { secret: true })
    const contribute = vi.fn()
    hydration.contribute('feature', contribute)
    hydration.contributeReconciliation('private', contribute)
    hydration.onValidate(contribute)
    expect(hydration.read('feature')).toBe(restored.feature)
    expect(hydration.readReconciliation('secret')).toBeUndefined()
    expect(hydration.collect()).toBeUndefined()
    expect(hydration.collectReconciliation()).toBeUndefined()
    hydration.forget('feature')
    expect(restored.feature).toEqual({ value: 1 })
    hydration.dispose()
    expect(contribute).not.toHaveBeenCalled()
  })

  it('reports actual bootstrap phases while preserving install, extensions and teardown', async () => {
    const phases: string[] = []
    profiler[timingKey] = (sample: { phase: string }) => phases.push(sample.phase)
    const order: string[] = []
    const dispose = vi.fn()
    let signal: AbortSignal | undefined
    document.body.innerHTML = '<div id="app"></div>'
    const mounted = await mountSpaApplication({
      id: 'profile',
      root: defineComponent(() => () => h('main', 'ready')),
      seo: { enabled: false },
      install({ context, hydration, resolution, server }) {
        expect(server).toBe(false)
        expect(resolution.server).toBe(false)
        signal = context.request.signal
        order.push('install')
        hydration.onDispose(dispose)
      },
      extensions: [{ name: 'custom', setup() { order.push('extension') } }],
    }, { domain: createTestDomain('performance.test') })
    try {
      expect(order).toEqual(['install', 'extension'])
      expect(phases).toEqual(['spa-start', 'application-ready', 'mount-start', 'spa-mounted'])
      expect(document.querySelector('main')?.textContent).toBe('ready')
    } finally { mounted.unmount() }
    expect(dispose).toHaveBeenCalledOnce()
    expect(signal?.aborted).toBe(true)
  })

  it('does not schedule idle work without a profiler and contains profiler failures', () => {
    const idle = vi.fn()
    vi.stubGlobal('requestIdleCallback', idle)
    markSsrBrowserIdle('app', new AbortController().signal)
    expect(idle).not.toHaveBeenCalled()
    profiler[timingKey] = () => { throw new Error('profiler failure') }
    expect(() => markSsrBrowserPhase('app', 'hydrate-start')).not.toThrow()
  })
})
