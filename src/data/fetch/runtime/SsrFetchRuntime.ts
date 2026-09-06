import { shallowRef, type InjectionKey, type ShallowRef } from 'vue'
import type { SsrHydrationController } from '../../../SsrHydrationRuntime'
import type { SsrRequestContext } from '../../../SsrRuntimeTypes'
import type { UseFetchError, UseFetchOptionsBase } from '../types/SsrFetchTypes'
import { SsrFetchCache, type FetchEntry } from './SsrFetchCache'
import {
  cancelPhysicalExecution,
  createPhysicalExecution,
  detachPhysicalObserver,
  fetchError,
  scheduleFetchTimeout,
  startPhysicalExecution,
  type FetchExecutionObserver,
  type FetchOutcome,
} from './SsrFetchExecution'
import {
  FETCH_HYDRATION_KEY,
  SsrFetchHydration,
  type HydratedFetchRecord,
  type ReconciledFetchRecord,
} from './SsrFetchHydration'
import { resolveFetchIdentity, type FetchIdentity } from './SsrFetchIdentity'

export const SSR_FETCH_RUNTIME: InjectionKey<SsrFetchRuntime> = Symbol('vue-ssr-lite:fetch-runtime')

interface LogicalExecution extends FetchExecutionObserver {
  cancel(): void
}

export interface HookConsumer {
  data: ShallowRef<unknown>
  pending: ShallowRef<boolean>
  error: ShallowRef<UseFetchError | null>
  identity: FetchIdentity
  entry: FetchEntry
  options: UseFetchOptionsBase<unknown, object>
  executions: Set<LogicalExecution>
  generation: number
  sequence: number
  progressed: boolean
  disposed: boolean
  deferred: boolean
  stop?: () => void
  reportError(error: unknown): void
}

/** Application-owned orchestration; physical requests and hook execution promises have distinct lifetimes. */
export class SsrFetchRuntime {
  readonly cache: SsrFetchCache
  readonly consumers = new Set<HookConsumer>()
  readonly continuation: SsrFetchHydration
  private disposed = false
  private aborted = false
  private contributing = false
  private readonly removeRequestAbort: () => void

  constructor(
    readonly server: boolean,
    readonly context: SsrRequestContext,
    private readonly hydration: SsrHydrationController,
    private hydrating: boolean
  ) {
    this.cache = new SsrFetchCache(server)
    const restored = hydration.read<Record<string, HydratedFetchRecord>>(FETCH_HYDRATION_KEY)
    const reconciliation = hydration.readReconciliation<Record<string, ReconciledFetchRecord>>(
      FETCH_HYDRATION_KEY
    )
    this.continuation = new SsrFetchHydration(restored, server, reconciliation)
    if (restored || reconciliation) this.contribute()
    hydration.onHydrated(() => {
      this.hydrating = false
      this.continuation.clear()
      hydration.forget(FETCH_HYDRATION_KEY)
      for (const consumer of [...this.consumers]) {
        if (consumer.deferred && !consumer.disposed) {
          consumer.deferred = false
          this.automatic(consumer)
        }
      }
    })
    const abort = () => {
      this.aborted = true
      for (const entry of this.cache.entries.values()) cancelPhysicalExecution(entry)
    }
    context.request.signal.addEventListener('abort', abort, { once: true })
    this.removeRequestAbort = () => context.request.signal.removeEventListener('abort', abort)
    if (context.request.signal.aborted) abort()
    hydration.onDispose(() => this.dispose())
  }

  private contribute(): void {
    if (this.contributing) return
    this.contributing = true
    this.hydration.contribute(FETCH_HYDRATION_KEY, () => this.continuation.snapshot(this.cache, this.consumers, false))
    this.hydration.contributeReconciliation(
      FETCH_HYDRATION_KEY,
      () => this.continuation.snapshotReconciliation(this.cache, this.consumers)
    )
    this.hydration.onValidate(() => { this.continuation.snapshot(this.cache, this.consumers, true) })
  }

  resolve(input: string | URL, variables: unknown, options: UseFetchOptionsBase<unknown, object>): FetchIdentity {
    return resolveFetchIdentity(input, variables, options, { server: this.server, request: this.context.request })
  }

  createConsumer(
    identity: FetchIdentity,
    options: UseFetchOptionsBase<unknown, object>,
    reportError: (error: unknown) => void
  ): HookConsumer {
    if (this.disposed) throw new Error('useFetch() cannot run in a disposed vue-ssr-lite application.')
    this.contribute()
    for (const policy of [options.fetchPolicy, options.nextFetchPolicy]) {
      if (policy !== undefined && policy !== 'network-only' && policy !== 'cache-first') {
        throw new Error('useFetch() fetch policies must be "network-only" or "cache-first".')
      }
    }
    if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0)) {
      throw new Error('useFetch() timeout must be a finite, non-negative number of milliseconds.')
    }
    if (options.signal != null && (
      typeof options.signal.aborted !== 'boolean' ||
      typeof options.signal.addEventListener !== 'function' ||
      typeof options.signal.removeEventListener !== 'function'
    )) throw new Error('useFetch() signal must be an AbortSignal.')
    const refs = { data: shallowRef<unknown>(), pending: shallowRef(false), error: shallowRef<UseFetchError | null>(null) }
    const consumer: HookConsumer = {
      ...refs,
      identity,
      entry: this.cache.acquire(identity, refs),
      options,
      executions: new Set(),
      generation: 0,
      sequence: 0,
      progressed: false,
      disposed: false,
      deferred: false,
      reportError,
    }
    // The entry holds the actual consumer, not a second observer lifetime.
    consumer.entry.observers.delete(refs)
    consumer.entry.observers.add(consumer)
    this.consumers.add(consumer)
    return consumer
  }

  initialize(consumer: HookConsumer): Promise<void> {
    try {
      const restored = this.continuation.restore(consumer.identity, consumer.entry)
      if (restored) {
        consumer.data.value = restored.state.data
        consumer.pending.value = restored.state.pending
        consumer.error.value = restored.state.error ? Object.freeze({ ...restored.state.error }) : null
        if (consumer.options.immediate !== false && !(this.server && consumer.options.server === false)) {
          // The pending server:false skeleton is continuation, not a completed decision.
          consumer.progressed = !restored.state.pending && Boolean(restored.cache || restored.state.error)
          if (this.hydrating && restored.state.pending) consumer.deferred = true
        }
        return Promise.resolve()
      }
      if (consumer.options.immediate === false) return Promise.resolve()
      if (consumer.options.server === false && (this.server || this.hydrating)) {
        consumer.pending.value = true
        consumer.deferred = this.hydrating
        return Promise.resolve()
      }
      return this.automatic(consumer)
    } catch (error) {
      this.release(consumer)
      throw error
    }
  }

  move(consumer: HookConsumer, identity: FetchIdentity): boolean {
    if (consumer.disposed) return false
    const changed = consumer.identity.runtimeKey !== identity.runtimeKey
    const variablesChanged = consumer.identity.variablesKey !== identity.variablesKey
    if (!changed && !variablesChanged) return false
    // Invalidate before detaching: neither cancellation nor stale results own new-key refs.
    const generation = ++consumer.generation
    for (const execution of [...consumer.executions]) execution.cancel()
    if (changed) {
      this.cache.release(consumer.entry, consumer)
      consumer.entry = this.cache.acquire(identity, consumer)
    }
    consumer.identity = identity
    // Install the entire non-reactive identity first. Synchronous watchers may
    // start another transition while any of the following refs are written.
    if (changed) consumer.data.value = undefined
    if (consumer.generation === generation) consumer.error.value = null
    if (consumer.generation === generation) consumer.pending.value = false
    return consumer.generation === generation
  }

  automatic(consumer: HookConsumer): Promise<void> {
    if (consumer.disposed || consumer.options.immediate === false) return Promise.resolve()
    if ((this.server && consumer.options.server === false) || consumer.deferred) {
      consumer.pending.value = true
      return Promise.resolve()
    }
    if (this.resume(consumer)) {
      consumer.progressed ||= consumer.entry.hasData || consumer.error.value !== null
      return Promise.resolve()
    }
    const policy = consumer.progressed
      ? consumer.options.nextFetchPolicy ?? consumer.options.fetchPolicy ?? 'network-only'
      : consumer.options.fetchPolicy ?? 'network-only'
    if (policy === 'cache-first' && consumer.entry.hasData) {
      const generation = consumer.generation
      const sequence = ++consumer.sequence
      const current = () => consumer.generation === generation && consumer.sequence === sequence && !consumer.disposed
      consumer.progressed = true
      consumer.data.value = consumer.entry.data
      if (current()) consumer.error.value = null
      if (current()) consumer.pending.value = false
      return Promise.resolve()
    }
    return this.execute(consumer, true)
  }

  refresh(consumer: HookConsumer): Promise<void> {
    consumer.deferred = false
    return this.execute(consumer, false)
  }

  private resume(consumer: HookConsumer): boolean {
    if (!this.server || consumer.disposed) return false
    const record = this.continuation.restore(consumer.identity, consumer.entry)
    if (!record || record.state.pending) return false
    consumer.data.value = record.state.data
    consumer.pending.value = false
    consumer.error.value = record.state.error ? Object.freeze({ ...record.state.error }) : null
    return true
  }

  private execute(consumer: HookConsumer, automatic: boolean): Promise<void> {
    if (consumer.disposed || this.disposed) return Promise.resolve()
    const { entry, identity, generation, options } = consumer
    const { signal, timeout, onDone, onError } = options
    const sequence = ++consumer.sequence
    const physical = entry.execution ?? createPhysicalExecution(entry)
    let resolve!: () => void
    const promise = new Promise<void>((accept) => { resolve = accept })
    let settled = false
    let cancelTimeout: () => void = () => undefined
    const current = () => !consumer.disposed && consumer.generation === generation
    const latest = () => current() && sequence === consumer.sequence
    const callback = (outcome: FetchOutcome) => {
      if (!current() || outcome.kind === 'cancelled') return
      const common = { variables: identity.variables, key: identity.publicKey, server: this.server }
      try {
        const returned = outcome.kind === 'success'
          ? onDone?.(Object.freeze({ ...common, data: outcome.data, status: outcome.status, statusText: outcome.statusText }))
          : onError?.(Object.freeze({ ...common, error: outcome.error, status: outcome.error.status, statusText: outcome.error.statusText }))
        // TS void callbacks may still be async. Their rejected promises must not
        // become unhandled rejections or change the already-committed query state.
        if (returned !== undefined) void Promise.resolve(returned).catch(consumer.reportError)
      } catch (error) {
        consumer.reportError(error)
      }
    }
    const logical: LogicalExecution = {
      cancel: () => logical.settle({ kind: 'cancelled' }),
      settle: (outcome) => {
        if (settled) return
        settled = true
        cancelTimeout()
        signal?.removeEventListener('abort', logical.cancel)
        consumer.executions.delete(logical)
        detachPhysicalObserver(entry, physical, logical, this.cache)
        try {
          if (current()) {
            if (automatic && outcome.kind !== 'cancelled') consumer.progressed = true
            if (latest()) consumer.error.value = outcome.kind === 'error' ? outcome.error : null
            if (latest()) consumer.pending.value = false
            if (this.server && latest()) {
              entry.lastState = {
                data: consumer.data.value, pending: consumer.pending.value, error: consumer.error.value,
              }
            }
            callback(outcome)
          }
        } catch (error) {
          consumer.reportError(error)
        } finally {
          resolve()
        }
      },
    }
    consumer.executions.add(logical)
    physical.observers.add(logical)
    signal?.addEventListener('abort', logical.cancel, { once: true })
    cancelTimeout = scheduleFetchTimeout(timeout, () => logical.settle({ kind: 'error', error: fetchError('timeout') }))
    try {
      if (latest()) consumer.error.value = null
      if (latest()) consumer.pending.value = true
    } catch (error) {
      consumer.reportError(error)
    }
    if (this.aborted || signal?.aborted || !current()) logical.cancel()
    if (!physical.started && !physical.settled) {
      startPhysicalExecution(entry, physical, identity, this.cache, () => {
        if (this.server && [...entry.observers].some((observer) => !(observer as HookConsumer).executions.size)) {
          this.context.resolution.requestAdditionalPass()
        }
      })
    }
    return promise
  }

  release(consumer: HookConsumer): void {
    if (consumer.disposed) return
    // Retire ownership before notifying refs: user sync watchers may attempt a
    // refresh during teardown, and must not reattach a disposed consumer.
    consumer.disposed = true
    consumer.deferred = false
    consumer.stop?.()
    consumer.stop = undefined
    for (const execution of [...consumer.executions]) execution.cancel()
    try {
      consumer.error.value = null
      consumer.pending.value = false
    } catch (error) {
      consumer.reportError(error)
    }
    this.consumers.delete(consumer)
    this.cache.release(consumer.entry, consumer)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.removeRequestAbort()
    for (const consumer of [...this.consumers]) this.release(consumer)
    for (const entry of this.cache.entries.values()) cancelPhysicalExecution(entry)
    this.continuation.clear()
    this.hydration.forget(FETCH_HYDRATION_KEY)
    this.cache.clear()
  }
}
