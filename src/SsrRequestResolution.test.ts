import { describe, expect, it } from 'vitest'
import { createSsrResolutionController } from './SsrRequestResolution'

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('SsrResolutionController', () => {
  it('tracks unsettled work and clears it once settled', async () => {
    const controller = createSsrResolutionController(true)
    let resolve!: () => void
    const work = new Promise<void>((r) => {
      resolve = r
    })
    controller.track(work)
    expect(controller.pendingWork()).toHaveLength(1)

    resolve()
    await work
    await flushMicrotasks()
    expect(controller.pendingWork()).toHaveLength(0)
  })

  it('is inert in the browser', () => {
    const controller = createSsrResolutionController(false)
    controller.track(Promise.resolve('ignored'))
    controller.requestAdditionalPass()
    expect(controller.pendingWork()).toHaveLength(0)
    expect(controller.additionalPassRequested()).toBe(false)
  })

  it('drains a waterfall: work registered while awaiting is included', async () => {
    const controller = createSsrResolutionController(true)
    const first = new Promise<void>((r) => setTimeout(r, 5))
    controller.track(first)
    void first.then(() =>
      controller.track(new Promise<void>((r) => setTimeout(r, 5)))
    )

    const settled = await controller.drain(1_000)
    expect(settled).toBe(true)
    expect(controller.pendingWork()).toHaveLength(0)
  })

  it('honours the deadline when work never settles', async () => {
    const controller = createSsrResolutionController(true)
    controller.track(new Promise<void>(() => {}))
    const settled = await controller.drain(20)
    expect(settled).toBe(false)
  })

  it('stops draining when the request is aborted', async () => {
    const controller = createSsrResolutionController(true)
    controller.track(new Promise<void>(() => {}))
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 10)
    const settled = await controller.drain(1_000, abort.signal)
    expect(settled).toBe(false)
  })

  it('beginPass advances the pass index and clears the pass request', () => {
    const controller = createSsrResolutionController(true)
    controller.requestAdditionalPass()
    expect(controller.additionalPassRequested()).toBe(true)

    controller.beginPass(1)
    expect(controller.pass).toBe(1)
    expect(controller.additionalPassRequested()).toBe(false)
  })

  it('does not swallow the original rejection of tracked work', async () => {
    const controller = createSsrResolutionController(true)
    const failure = new Error('boom')
    const work = controller.track(Promise.reject(failure))
    await expect(work).rejects.toBe(failure)
    await flushMicrotasks()
    expect(controller.pendingWork()).toHaveLength(0)
  })
})
