import type { UseFetchError } from '../types/SsrFetchTypes'
import type { FetchEntry, SsrFetchCache } from './SsrFetchCache'
import type { FetchIdentity } from './SsrFetchIdentity'

export type FetchOutcome =
  | { kind: 'success'; data: unknown; status: number; statusText: string }
  | { kind: 'error'; error: UseFetchError }
  | { kind: 'cancelled' }

export interface FetchExecutionObserver {
  settle(outcome: FetchOutcome): void
}

export interface FetchPhysicalExecution {
  controller: AbortController
  observers: Set<FetchExecutionObserver>
  settled: boolean
  started: boolean
  promise?: Promise<void>
}

export const fetchError = (
  kind: UseFetchError['kind'],
  metadata?: { status: number; statusText: string }
): UseFetchError => Object.freeze({
  name: 'UseFetchError',
  kind,
  message: {
    http: 'The request returned an unsuccessful HTTP status.',
    network: 'The network request failed.',
    parse: 'The response could not be parsed as JSON.',
    timeout: 'The request timed out.',
  }[kind],
  ...(metadata ? { status: metadata.status, statusText: metadata.statusText } : {}),
})

/** Native timers overflow above 2^31-1ms. Long timeouts retain their requested duration. */
export const scheduleFetchTimeout = (duration: number | undefined, expire: () => void): (() => void) => {
  if (!duration) return () => undefined
  let remaining = duration
  let started = performance.now()
  let timer: ReturnType<typeof setTimeout>
  const tick = () => {
    const now = performance.now()
    remaining -= now - started
    started = now
    if (remaining <= 0) expire()
    else timer = setTimeout(tick, Math.min(Math.ceil(remaining), 2 ** 31 - 1))
  }
  timer = setTimeout(tick, Math.min(Math.ceil(remaining), 2 ** 31 - 1))
  return () => clearTimeout(timer)
}

const performFetch = async (identity: FetchIdentity, signal: AbortSignal): Promise<FetchOutcome> => {
  try {
    const response = await fetch(identity.url, { ...identity.init, signal })
    if (signal.aborted) return { kind: 'cancelled' }
    const metadata = { status: response.status, statusText: response.statusText }
    if (!response.ok) {
      // Discard unread bodies without keeping streams or native responses in cache.
      void response.body?.cancel().catch(() => undefined)
      return { kind: 'error', error: fetchError('http', metadata) }
    }
    let data: unknown
    if (identity.init.method !== 'HEAD' && response.status !== 204 && response.status !== 205) {
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
      const json = /^application\/(?:json|[^\s/;]+\+json)$/.test(contentType)
      // Body transport failures are network errors; only JSON decoding is parse.
      const body = await response.text()
      if (json) {
        try {
          data = JSON.parse(body)
        } catch {
          return { kind: 'error', error: fetchError('parse', metadata) }
        }
      } else {
        data = body
      }
    } else {
      void response.body?.cancel().catch(() => undefined)
    }
    return signal.aborted ? { kind: 'cancelled' } : { kind: 'success', data, ...metadata }
  } catch {
    // Native errors may embed URLs, headers, tokens or stacks. Never hydrate them.
    return signal.aborted ? { kind: 'cancelled' } : { kind: 'error', error: fetchError('network') }
  }
}

export const createPhysicalExecution = (entry: FetchEntry): FetchPhysicalExecution => {
  const execution: FetchPhysicalExecution = {
    controller: new AbortController(),
    observers: new Set(),
    settled: false,
    started: false,
  }
  entry.execution = execution
  return execution
}

/** Called after the first logical observer attaches, synchronously during setup. */
export const startPhysicalExecution = (
  entry: FetchEntry,
  execution: FetchPhysicalExecution,
  identity: FetchIdentity,
  cache: SsrFetchCache,
  onCommit: () => void
): void => {
  if (execution.started || execution.settled) return
  execution.started = true
  execution.promise = performFetch(identity, execution.controller.signal).then((outcome) => {
    if (execution.settled || entry.execution !== execution) return
    execution.settled = true
    entry.execution = undefined
    if (outcome.kind === 'success') {
      cache.commit(entry, outcome.data, identity.browserReusable)
      onCommit()
    }
    for (const observer of [...execution.observers]) observer.settle(outcome)
    execution.observers.clear()
    cache.prune(entry)
  })
}

export const detachPhysicalObserver = (
  entry: FetchEntry,
  execution: FetchPhysicalExecution,
  observer: FetchExecutionObserver,
  cache: SsrFetchCache
): void => {
  execution.observers.delete(observer)
  if (!execution.settled && !execution.observers.size) {
    execution.settled = true
    if (entry.execution === execution) entry.execution = undefined
    execution.controller.abort()
    cache.prune(entry)
  }
}

export const cancelPhysicalExecution = (entry: FetchEntry): void => {
  const execution = entry.execution
  if (!execution) return
  execution.settled = true
  entry.execution = undefined
  execution.controller.abort()
  for (const observer of [...execution.observers]) observer.settle({ kind: 'cancelled' })
  execution.observers.clear()
}
