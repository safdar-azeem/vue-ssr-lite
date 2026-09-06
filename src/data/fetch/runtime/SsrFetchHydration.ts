import type { ShallowRef } from 'vue'
import { serializeSsrState } from '../../../SsrSerialization'
import type { UseFetchError } from '../types/SsrFetchTypes'
import type { FetchEntry, SsrFetchCache } from './SsrFetchCache'
import type { FetchIdentity } from './SsrFetchIdentity'

export const FETCH_HYDRATION_KEY = 'vue-ssr-lite:fetch'

export interface HydratedFetchRecord {
  state: { data: unknown; pending: boolean; error: UseFetchError | null }
  cache?: {
    data: unknown
    /** Missing on older payloads; browsers must treat absence as non-reusable. */
    browserReusable?: boolean
  }
}

/** Request-local SSR reconciliation metadata. Never serialize this structure. */
export interface ReconciledFetchRecord {
  /** May encode credentials. Request-local only; never log or serialize it. */
  fingerprint: string
  /** Historical continuation needed if this identity returns in a later SSR pass. */
  record: HydratedFetchRecord
}

export interface FetchHydrationConsumer {
  entry: FetchEntry
  data: ShallowRef<unknown>
  pending: ShallowRef<boolean>
  error: ShallowRef<UseFetchError | null>
}

const collision = (publicKey: string, browser: boolean): Error => new Error(
  `useFetch() ${browser ? 'hydration' : 'SSR'} configuration mismatch for public identity ${publicKey}. ` +
  'Provide distinct explicit keys, for example "customer-profile" and "admin-profile", ' +
  'for consumers with different request options or rendered state.'
)

/** Only approved fields can cross the hydration boundary, even if refs were modified by application code. */
const safeError = (error: UseFetchError | null): UseFetchError | null => error === null ? null : ({
  name: 'UseFetchError',
  kind: error.kind,
  message: error.message,
  ...(error.status === undefined ? {} : { status: error.status }),
  ...(error.statusText === undefined ? {} : { statusText: error.statusText }),
})

export class SsrFetchHydration {
  private readonly records = new Map<string, HydratedFetchRecord>()
  private readonly bindings = new Map<string, string>()
  private readonly reconciliation = new Map<string, ReconciledFetchRecord>()

  constructor(
    restored: Record<string, HydratedFetchRecord> | undefined,
    private readonly server: boolean,
    restoredReconciliation?: Record<string, ReconciledFetchRecord>
  ) {
    for (const [key, record] of Object.entries(restored ?? {})) this.records.set(key, record)
    if (server) {
      for (const [key, record] of Object.entries(restoredReconciliation ?? {})) {
        this.reconciliation.set(key, record)
      }
    }
  }

  restore(identity: FetchIdentity, entry: FetchEntry): HydratedFetchRecord | undefined {
    const reconciled = this.server
      ? this.reconciliation.get(identity.publicKey)
      : undefined
    const record = reconciled?.record ?? this.records.get(identity.publicKey)
    if (!record) return
    if (this.server) {
      // A public record without its request-local identity cannot safely resume,
      // and a different private representation must never inherit its result.
      if (!reconciled || reconciled.fingerprint !== identity.fingerprint) {
        throw collision(identity.publicKey, false)
      }
    }
    const binding = this.bindings.get(identity.publicKey)
    if (binding !== undefined && binding !== identity.fingerprint) {
      throw collision(identity.publicKey, !this.server)
    }
    this.bindings.set(identity.publicKey, identity.fingerprint)
    // State continuation is always authoritative for initial markup. Persistent
    // browser cache adoption additionally requires safe successful provenance
    // AND compatible anonymous browser semantics. SSR reconciliation may
    // restore private data only after the request-local comparison above.
    if (record.cache && !entry.hasData && (
      this.server || (record.cache.browserReusable === true && identity.browserReusable)
    )) {
      entry.hasData = true
      entry.data = record.cache.data
      entry.browserReusable = record.cache.browserReusable === true
    }
    return record
  }

  snapshot(
    cache: SsrFetchCache,
    consumers: Iterable<FetchHydrationConsumer>,
    validate: boolean
  ): Record<string, HydratedFetchRecord> {
    const groups = new Map<string, { entries: FetchEntry[]; states: HydratedFetchRecord['state'][] }>()
    for (const entry of cache.entries.values()) {
      const group = groups.get(entry.publicKey) ?? { entries: [], states: [] }
      group.entries.push(entry)
      groups.set(entry.publicKey, group)
    }
    for (const consumer of consumers) {
      groups.get(consumer.entry.publicKey)!.states.push({
        data: consumer.data.value,
        pending: consumer.pending.value,
        error: safeError(consumer.error.value),
      })
    }
    // Browser hydration is a projection of this render pass only. Historical
    // records live exclusively in the request-local reconciliation map below.
    const result: Record<string, HydratedFetchRecord> = {}
    for (const [publicKey, group] of groups) {
      const entry = group.entries[0]!
      const state = group.states[0] ?? entry.lastState ??
        this.reconciliation.get(publicKey)?.record.state ??
        this.records.get(publicKey)?.state ?? {
        data: entry.data, pending: false, error: null,
      }
      if (validate && (
        group.entries.some((candidate) => candidate.fingerprint !== entry.fingerprint) ||
        group.states.some((candidate) => serializeSsrState(candidate) !== serializeSsrState(state))
      )) throw collision(publicKey, false)
      result[publicKey] = {
        state,
        ...(entry.hasData ? { cache: { data: entry.data, browserReusable: entry.browserReusable } } : {}),
      }
    }
    return result
  }

  /** Snapshot private identity and historical continuation for this request's next pass. */
  snapshotReconciliation(
    cache: SsrFetchCache,
    consumers: Iterable<FetchHydrationConsumer>
  ): Record<string, ReconciledFetchRecord> {
    const result: Record<string, ReconciledFetchRecord> = {}
    for (const [publicKey, record] of this.reconciliation) {
      result[publicKey] = { fingerprint: record.fingerprint, record: record.record }
    }
    const current = this.snapshot(cache, consumers, true)
    for (const entry of cache.entries.values()) {
      const record = current[entry.publicKey]
      if (!record) continue
      const prior = result[entry.publicKey]
      if (prior && prior.fingerprint !== entry.fingerprint) {
        throw collision(entry.publicKey, false)
      }
      result[entry.publicKey] = { fingerprint: entry.fingerprint, record }
    }
    return result
  }

  clear(): void {
    this.records.clear()
    this.bindings.clear()
    this.reconciliation.clear()
  }
}
