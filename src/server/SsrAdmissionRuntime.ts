export interface SsrAdmissionLease {
  /** Idempotently return this request's one active SSR slot. */
  release(): void
}

export interface SsrAdmissionAcquireOptions {
  /** The canonical request cancellation signal. */
  signal: AbortSignal
  requestId: string
  entryId: string
}

export interface SsrAdmissionSnapshot {
  activeCount: number
  queuedCount: number
}

export type SsrAdmissionEvent =
  | (SsrAdmissionSnapshot & {
      type: 'queued' | 'cancelled'
      requestId: string
      entryId: string
    })
  | (SsrAdmissionSnapshot & {
      type: 'admitted'
      requestId: string
      entryId: string
      queueWaitDurationMs: number
    })
  | (SsrAdmissionSnapshot & {
      type: 'rejected'
      requestId: string
      entryId: string
    })
  | (SsrAdmissionSnapshot & {
      type: 'disposed'
      rejectedQueuedCount: number
    })

export interface SsrAdmissionController {
  acquire(options: SsrAdmissionAcquireOptions): Promise<SsrAdmissionLease>
  snapshot(): SsrAdmissionSnapshot
  dispose(): void
}

export interface SsrAdmissionControllerOptions {
  maxConcurrent: number
  maxQueued: number
  onEvent?: (event: SsrAdmissionEvent) => void
}

/** Base class for capacity failures that should become a controlled 503. */
export class SsrAdmissionUnavailableError extends Error {}

export class SsrAdmissionOverloadedError extends SsrAdmissionUnavailableError {
  constructor() {
    super('SSR admission capacity is exhausted.')
    this.name = 'SsrAdmissionOverloadedError'
  }
}

export class SsrAdmissionDisposedError extends SsrAdmissionUnavailableError {
  constructor() {
    super('SSR admission controller is disposed.')
    this.name = 'SsrAdmissionDisposedError'
  }
}

interface SsrAdmissionWaiter {
  readonly signal: AbortSignal
  readonly requestId: string
  readonly entryId: string
  readonly queuedAt: number
  readonly resolve: (lease: SsrAdmissionLease) => void
  readonly reject: (error: unknown) => void
  onAbort: () => void
  settled: boolean
}

const assertPositiveInteger = (value: number, label: string): void => {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive integer.`)
  }
}

const assertNonNegativeInteger = (value: number, label: string): void => {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative integer.`)
  }
}

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new Error('SSR admission was cancelled.')

/**
 * Create one in-process admission boundary for one managed server.
 *
 * Invariants:
 * - activeCount never exceeds maxConcurrent;
 * - every admitted request owns exactly one idempotent lease;
 * - cancelled queued requests are removed and never execute;
 * - queue length never exceeds maxQueued;
 * - release transfers an occupied slot directly to the oldest valid waiter.
 */
export const createSsrAdmissionController = (
  options: SsrAdmissionControllerOptions
): SsrAdmissionController => {
  assertPositiveInteger(options.maxConcurrent, 'maxConcurrent')
  assertNonNegativeInteger(options.maxQueued, 'maxQueued')

  let activeCount = 0
  let disposed = false
  const queue: SsrAdmissionWaiter[] = []

  const snapshot = (): SsrAdmissionSnapshot => ({
    activeCount,
    queuedCount: queue.length,
  })
  const emit = (event: SsrAdmissionEvent): void => {
    try {
      options.onEvent?.(event)
    } catch {
      // Admission observability must never affect request availability.
    }
  }
  const cleanWaiter = (waiter: SsrAdmissionWaiter): void => {
    waiter.signal.removeEventListener('abort', waiter.onAbort)
  }
  const createLease = (): SsrAdmissionLease => {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        releaseSlot()
      },
    }
  }
  const rejectWaiter = (waiter: SsrAdmissionWaiter, error: unknown): void => {
    if (waiter.settled) return
    waiter.settled = true
    cleanWaiter(waiter)
    waiter.reject(error)
  }
  const releaseSlot = (): void => {
    while (queue.length > 0) {
      const waiter = queue.shift()!
      if (waiter.settled) continue
      if (waiter.signal.aborted) {
        rejectWaiter(waiter, abortReason(waiter.signal))
        emit({
          type: 'cancelled',
          requestId: waiter.requestId,
          entryId: waiter.entryId,
          ...snapshot(),
        })
        continue
      }

      // Direct handoff keeps activeCount unchanged: the released slot remains
      // occupied by exactly one request throughout the transfer.
      waiter.settled = true
      cleanWaiter(waiter)
      emit({
        type: 'admitted',
        requestId: waiter.requestId,
        entryId: waiter.entryId,
        queueWaitDurationMs: Math.max(0, Date.now() - waiter.queuedAt),
        ...snapshot(),
      })
      waiter.resolve(createLease())
      return
    }
    activeCount -= 1
  }

  return {
    acquire: (acquireOptions) => {
      const { signal, requestId, entryId } = acquireOptions
      if (signal.aborted) return Promise.reject(abortReason(signal))
      if (disposed) return Promise.reject(new SsrAdmissionDisposedError())
      if (activeCount < options.maxConcurrent) {
        activeCount += 1
        return Promise.resolve(createLease())
      }
      if (queue.length >= options.maxQueued) {
        emit({ type: 'rejected', requestId, entryId, ...snapshot() })
        return Promise.reject(new SsrAdmissionOverloadedError())
      }

      return new Promise<SsrAdmissionLease>((resolve, reject) => {
        const waiter: SsrAdmissionWaiter = {
          signal,
          requestId,
          entryId,
          queuedAt: Date.now(),
          resolve,
          reject,
          onAbort: () => undefined,
          settled: false,
        }
        waiter.onAbort = () => {
          if (waiter.settled) return
          const index = queue.indexOf(waiter)
          if (index >= 0) queue.splice(index, 1)
          rejectWaiter(waiter, abortReason(signal))
          emit({ type: 'cancelled', requestId, entryId, ...snapshot() })
        }
        queue.push(waiter)
        signal.addEventListener('abort', waiter.onAbort, { once: true })
        emit({ type: 'queued', requestId, entryId, ...snapshot() })
      })
    },
    snapshot,
    dispose: () => {
      if (disposed) return
      disposed = true
      const waiters = queue.splice(0)
      const error = new SsrAdmissionDisposedError()
      for (const waiter of waiters) rejectWaiter(waiter, error)
      emit({
        type: 'disposed',
        rejectedQueuedCount: waiters.length,
        ...snapshot(),
      })
    },
  }
}
