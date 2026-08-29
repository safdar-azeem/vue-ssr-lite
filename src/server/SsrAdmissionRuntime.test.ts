import { describe, expect, it, vi } from 'vitest'
import {
  createSsrAdmissionController,
  SsrAdmissionDisposedError,
  SsrAdmissionOverloadedError,
  type SsrAdmissionEvent,
} from './SsrAdmissionRuntime'

const acquisition = (signal: AbortSignal, requestId: string) => ({
  signal,
  requestId,
  entryId: 'app',
})

describe('SSR admission controller', () => {
  it.each([
    [0, 0],
    [-1, 0],
    [1.5, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ])('rejects invalid active capacity %s', (maxConcurrent, maxQueued) => {
    expect(() => createSsrAdmissionController({ maxConcurrent, maxQueued })).toThrow(
      'maxConcurrent must be a finite positive integer.'
    )
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid queue capacity %s',
    (maxQueued) => {
      expect(() => createSsrAdmissionController({ maxConcurrent: 1, maxQueued })).toThrow(
        'maxQueued must be a finite non-negative integer.'
      )
    }
  )

  it('admits immediately and makes each lease idempotent', async () => {
    const controller = createSsrAdmissionController({ maxConcurrent: 2, maxQueued: 1 })
    const lease = await controller.acquire(
      acquisition(new AbortController().signal, 'immediate')
    )

    expect(controller.snapshot()).toEqual({ activeCount: 1, queuedCount: 0 })
    lease.release()
    lease.release()
    expect(controller.snapshot()).toEqual({ activeCount: 0, queuedCount: 0 })
  })

  it('never consumes capacity for a signal that was already aborted', async () => {
    const controller = createSsrAdmissionController({ maxConcurrent: 1, maxQueued: 1 })
    const aborted = new AbortController()
    const cancellation = new Error('already cancelled')
    aborted.abort(cancellation)

    await expect(
      controller.acquire(acquisition(aborted.signal, 'aborted'))
    ).rejects.toBe(cancellation)
    expect(controller.snapshot()).toEqual({ activeCount: 0, queuedCount: 0 })
  })

  it('bounds active execution and hands capacity to queued requests in FIFO order', async () => {
    const controller = createSsrAdmissionController({ maxConcurrent: 1, maxQueued: 2 })
    const first = await controller.acquire(
      acquisition(new AbortController().signal, 'first')
    )
    const order: string[] = []
    const secondPromise = controller
      .acquire(acquisition(new AbortController().signal, 'second'))
      .then((lease) => {
        order.push('second')
        return lease
      })
    const thirdPromise = controller
      .acquire(acquisition(new AbortController().signal, 'third'))
      .then((lease) => {
        order.push('third')
        return lease
      })

    expect(controller.snapshot()).toEqual({ activeCount: 1, queuedCount: 2 })
    first.release()
    const second = await secondPromise
    expect(order).toEqual(['second'])
    expect(controller.snapshot()).toEqual({ activeCount: 1, queuedCount: 1 })

    second.release()
    const third = await thirdPromise
    expect(order).toEqual(['second', 'third'])
    expect(controller.snapshot()).toEqual({ activeCount: 1, queuedCount: 0 })
    third.release()
  })

  it('rejects predictably when both active and queued capacity are full', async () => {
    const controller = createSsrAdmissionController({ maxConcurrent: 1, maxQueued: 1 })
    const active = await controller.acquire(
      acquisition(new AbortController().signal, 'active')
    )
    const queued = controller.acquire(
      acquisition(new AbortController().signal, 'queued')
    )

    await expect(
      controller.acquire(acquisition(new AbortController().signal, 'overflow'))
    ).rejects.toBeInstanceOf(SsrAdmissionOverloadedError)
    expect(controller.snapshot()).toEqual({ activeCount: 1, queuedCount: 1 })

    active.release()
    const queuedLease = await queued
    queuedLease.release()
  })

  it('supports a zero-length queue', async () => {
    const controller = createSsrAdmissionController({ maxConcurrent: 1, maxQueued: 0 })
    const active = await controller.acquire(
      acquisition(new AbortController().signal, 'active')
    )

    await expect(
      controller.acquire(acquisition(new AbortController().signal, 'overflow'))
    ).rejects.toBeInstanceOf(SsrAdmissionOverloadedError)
    expect(controller.snapshot()).toEqual({ activeCount: 1, queuedCount: 0 })
    active.release()
  })

  it('removes a cancelled waiter immediately and never admits it later', async () => {
    const controller = createSsrAdmissionController({ maxConcurrent: 1, maxQueued: 1 })
    const active = await controller.acquire(
      acquisition(new AbortController().signal, 'active')
    )
    const queuedController = new AbortController()
    const queued = controller.acquire(acquisition(queuedController.signal, 'cancelled'))
    const cancellation = new Error('client disconnected')
    const rejected = expect(queued).rejects.toBe(cancellation)

    queuedController.abort(cancellation)
    await rejected
    expect(controller.snapshot()).toEqual({ activeCount: 1, queuedCount: 0 })

    const replacement = controller.acquire(
      acquisition(new AbortController().signal, 'replacement')
    )
    active.release()
    const replacementLease = await replacement
    expect(controller.snapshot()).toEqual({ activeCount: 1, queuedCount: 0 })
    replacementLease.release()
  })

  it('advances past a cancelled first waiter without losing the released slot', async () => {
    const controller = createSsrAdmissionController({ maxConcurrent: 1, maxQueued: 2 })
    const active = await controller.acquire(
      acquisition(new AbortController().signal, 'active')
    )
    const cancelledController = new AbortController()
    const cancelled = controller.acquire(
      acquisition(cancelledController.signal, 'cancelled')
    )
    const next = controller.acquire(acquisition(new AbortController().signal, 'next'))
    const cancellation = new Error('deadline expired')
    const rejected = expect(cancelled).rejects.toBe(cancellation)

    cancelledController.abort(cancellation)
    await rejected
    active.release()
    const nextLease = await next
    expect(controller.snapshot()).toEqual({ activeCount: 1, queuedCount: 0 })
    nextLease.release()
  })

  it('settles an abort-versus-handoff race as admitted when direct handoff wins', async () => {
    const controller = createSsrAdmissionController({ maxConcurrent: 1, maxQueued: 1 })
    const active = await controller.acquire(
      acquisition(new AbortController().signal, 'active')
    )
    const waitingController = new AbortController()
    const waiting = controller.acquire(
      acquisition(waitingController.signal, 'waiting')
    )

    active.release()
    waitingController.abort(new Error('late cancellation'))
    const waitingLease = await waiting
    expect(controller.snapshot()).toEqual({ activeCount: 1, queuedCount: 0 })
    waitingLease.release()
  })

  it('keeps separately created server controllers isolated', async () => {
    const left = createSsrAdmissionController({ maxConcurrent: 1, maxQueued: 0 })
    const right = createSsrAdmissionController({ maxConcurrent: 1, maxQueued: 0 })
    const leftLease = await left.acquire(
      acquisition(new AbortController().signal, 'left')
    )

    expect(left.snapshot()).toEqual({ activeCount: 1, queuedCount: 0 })
    expect(right.snapshot()).toEqual({ activeCount: 0, queuedCount: 0 })
    const rightLease = await right.acquire(
      acquisition(new AbortController().signal, 'right')
    )
    expect(right.snapshot()).toEqual({ activeCount: 1, queuedCount: 0 })

    leftLease.release()
    rightLease.release()
  })

  it('disposal rejects queued and future acquisitions while active leases drain', async () => {
    const controller = createSsrAdmissionController({ maxConcurrent: 1, maxQueued: 1 })
    const active = await controller.acquire(
      acquisition(new AbortController().signal, 'active')
    )
    const queued = controller.acquire(
      acquisition(new AbortController().signal, 'queued')
    )
    const queuedRejection = expect(queued).rejects.toBeInstanceOf(SsrAdmissionDisposedError)

    controller.dispose()
    await queuedRejection
    await expect(
      controller.acquire(acquisition(new AbortController().signal, 'future'))
    ).rejects.toBeInstanceOf(SsrAdmissionDisposedError)
    expect(controller.snapshot()).toEqual({ activeCount: 1, queuedCount: 0 })

    active.release()
    expect(controller.snapshot()).toEqual({ activeCount: 0, queuedCount: 0 })
  })

  it('reports queue pressure, overload, cancellation, and wait-state counts', async () => {
    const events: SsrAdmissionEvent[] = []
    const controller = createSsrAdmissionController({
      maxConcurrent: 1,
      maxQueued: 1,
      onEvent: (event) => events.push(event),
    })
    const active = await controller.acquire(
      acquisition(new AbortController().signal, 'active')
    )
    const queued = controller.acquire(
      acquisition(new AbortController().signal, 'queued')
    )
    await expect(
      controller.acquire(acquisition(new AbortController().signal, 'overflow'))
    ).rejects.toBeInstanceOf(SsrAdmissionOverloadedError)
    active.release()
    const queuedLease = await queued
    queuedLease.release()

    const nextActive = await controller.acquire(
      acquisition(new AbortController().signal, 'next-active')
    )
    const cancelledController = new AbortController()
    const cancelled = controller.acquire(
      acquisition(cancelledController.signal, 'cancelled')
    )
    const rejected = expect(cancelled).rejects.toThrow('cancelled')
    cancelledController.abort(new Error('cancelled'))
    await rejected
    nextActive.release()

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'queued', activeCount: 1, queuedCount: 1 }),
        expect.objectContaining({ type: 'rejected', activeCount: 1, queuedCount: 1 }),
        expect.objectContaining({
          type: 'admitted',
          activeCount: 1,
          queuedCount: 0,
          queueWaitDurationMs: expect.any(Number),
        }),
        expect.objectContaining({ type: 'cancelled', activeCount: 1, queuedCount: 0 }),
      ])
    )
  })

  it('does not let a throwing observability hook affect admission', async () => {
    const controller = createSsrAdmissionController({
      maxConcurrent: 1,
      maxQueued: 1,
      onEvent: vi.fn(() => {
        throw new Error('observability failed')
      }),
    })
    const active = await controller.acquire(
      acquisition(new AbortController().signal, 'active')
    )
    const queuedController = new AbortController()
    const queued = controller.acquire(acquisition(queuedController.signal, 'queued'))
    const rejected = expect(queued).rejects.toThrow('cancelled')

    queuedController.abort(new Error('cancelled'))
    await rejected
    active.release()
  })
})
