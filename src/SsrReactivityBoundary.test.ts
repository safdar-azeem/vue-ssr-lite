import { createSSRApp, effectScope, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { ssrWatch, ssrWatchEffect } from './SsrReactivityRuntime'
import { SSR_REQUEST_RESOLUTION, SSR_SERVER_REACTIVITY, type SsrRequestResolution } from './SsrRequestResolution'
import { createSsrResolutionController } from './SsrServerResolution'
import { fingerprintSsrReactivityValues } from './SsrServerReactivity'

describe('request-owned server reactivity dispatch', () => {
  it('retains fingerprinted watcher and effect reconciliation on the owning server request', () => {
    const requests = [createSsrResolutionController(true), createSsrResolutionController(true)]
    const scopes = requests.map(() => effectScope())
    const values = requests.map(() => ref(1))
    const callbacks = requests.map(() => vi.fn())
    const cleanups = requests.map(() => vi.fn())
    const watches = requests.map((resolution) => vi.spyOn(resolution, 'requestReactivityPass'))
    const effects = requests.map((resolution) => vi.spyOn(resolution, 'requestReactivityEffectPass'))
    try {
      requests.forEach((resolution, index) => {
        expect(resolution[SSR_SERVER_REACTIVITY]).toBeDefined()
        resolution.beginPass(0)
        const app = createSSRApp({ render: () => null })
        app.provide(SSR_REQUEST_RESOLUTION, resolution)
        scopes[index]!.run(() => app.runWithContext(() => {
          ssrWatch(values[index]!, (value, previous, onCleanup) => {
            callbacks[index]!(value, previous)
            onCleanup(cleanups[index]!)
          })
          ssrWatchEffect(() => { void values[index]!.value })
        }))
      })
      values[0]!.value = 2
      expect(callbacks[0]).toHaveBeenCalledWith(2, 1)
      expect(watches[0]).toHaveBeenCalledWith(expect.any(Object), fingerprintSsrReactivityValues([2, 1]), null)
      expect(effects[0]).toHaveBeenCalledOnce()
      expect(requests[0]!.additionalPassRequested()).toBe(true)
      expect(watches[1]).not.toHaveBeenCalled()
      expect(effects[1]).not.toHaveBeenCalled()
      expect(requests[1]!.additionalPassRequested()).toBe(false)
      values[1]!.value = 3
      expect(callbacks[1]).toHaveBeenCalledWith(3, 1)
      expect(watches[1]).toHaveBeenCalledOnce()
    } finally {
      scopes.forEach((scope) => scope.stop())
      requests.forEach((resolution) => resolution.dispose())
      vi.restoreAllMocks()
    }
    cleanups.forEach((cleanup) => expect(cleanup).toHaveBeenCalledOnce())
  })

  it('preserves the minimal public resolution contract for independent SSR hosts', () => {
    const additionalPass = vi.fn()
    const resolution: SsrRequestResolution = {
      server: true, pass: 0, track: (work) => work, requestAdditionalPass: additionalPass,
    }
    const app = createSSRApp({ render: () => null })
    const scope = effectScope()
    const value = ref(0)
    const observed: number[] = []
    app.provide(SSR_REQUEST_RESOLUTION, resolution)
    try {
      scope.run(() => app.runWithContext(() => {
        ssrWatch(value, (current) => observed.push(current), { immediate: true })
        ssrWatchEffect(() => { void value.value })
      }))
      expect(additionalPass).not.toHaveBeenCalled()
      value.value = 1
      expect(observed).toEqual([0, 1])
      expect(additionalPass).toHaveBeenCalledTimes(2)
    } finally { scope.stop() }
  })
})
