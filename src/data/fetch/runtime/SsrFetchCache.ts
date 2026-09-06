import type { ShallowRef } from 'vue'
import type { FetchIdentity } from './SsrFetchIdentity'
import type { FetchPhysicalExecution } from './SsrFetchExecution'
import type { HydratedFetchRecord } from './SsrFetchHydration'

export interface FetchCacheObserver {
  data: ShallowRef<unknown>
  reportError?(error: unknown): void
}

export interface FetchEntry {
  publicKey: string
  fingerprint: string
  runtimeKey: string
  hasData: boolean
  data: unknown
  /** Provenance of the last successful value, never of a later observer or failure. */
  browserReusable: boolean
  /** Request-local settled continuation for an identity no longer owned by a hook. */
  lastState?: HydratedFetchRecord['state']
  /** Live hooks, including idle, settled, timed-out and aborted hooks. */
  observers: Set<FetchCacheObserver>
  execution?: FetchPhysicalExecution
}

/** Own one cache per request/application; the LRU contains only successful orphans. */
export class SsrFetchCache {
  readonly entries = new Map<string, FetchEntry>()
  private readonly orphans = new Map<string, FetchEntry>()

  constructor(private readonly server: boolean) {}

  acquire(identity: FetchIdentity, observer: FetchCacheObserver): FetchEntry {
    let entry = this.entries.get(identity.runtimeKey)
    if (!entry) {
      entry = {
        publicKey: identity.publicKey,
        fingerprint: identity.fingerprint,
        runtimeKey: identity.runtimeKey,
        hasData: false,
        data: undefined,
        browserReusable: false,
        observers: new Set(),
      }
      this.entries.set(entry.runtimeKey, entry)
    }
    this.orphans.delete(entry.runtimeKey)
    entry.observers.add(observer)
    return entry
  }

  release(entry: FetchEntry, observer: FetchCacheObserver): void {
    entry.observers.delete(observer)
    this.prune(entry)
  }

  commit(entry: FetchEntry, data: unknown, browserReusable: boolean): void {
    entry.hasData = true
    entry.data = data
    entry.browserReusable = browserReusable
    for (const observer of [...entry.observers]) {
      // A synchronous Vue watcher can move another consumer to a new identity.
      if (entry.observers.has(observer)) {
        try {
          observer.data.value = data
        } catch (error) {
          // A throwing synchronous user watcher must not strand other observers.
          observer.reportError?.(error)
        }
      }
    }
    this.prune(entry)
  }

  prune(entry: FetchEntry): void {
    if (this.server || entry.observers.size || entry.execution) return
    if (!entry.hasData) {
      this.entries.delete(entry.runtimeKey)
      this.orphans.delete(entry.runtimeKey)
      return
    }
    this.orphans.delete(entry.runtimeKey)
    this.orphans.set(entry.runtimeKey, entry)
    while (this.orphans.size > 100) {
      const key = this.orphans.keys().next().value!
      this.orphans.delete(key)
      this.entries.delete(key)
    }
  }

  clear(): void {
    this.entries.clear()
    this.orphans.clear()
  }
}
