import { inject, type InjectionKey } from 'vue'

/**
 * Generic, framework-neutral server-render resolution contract.
 *
 * `renderToString` makes a single pass and awaits each component's native
 * `onServerPrefetch`. That covers data consumed reactively inside the component
 * that declared it, but it offers no way to:
 *
 *   1. await asynchronous work that was started OUTSIDE a component's own
 *      prefetch lifecycle (a store action, an i18n loader, a lazy query), or
 *   2. tell the renderer that application state settled AFTER the first pass and
 *      the tree should be produced again.
 *
 * This contract closes both gaps without `vue-ssr-lite` learning anything about
 * the plugin doing the work. An installed plugin — an API client, a store, an
 * i18n cache — obtains the active resolution by injecting
 * {@link SSR_REQUEST_RESOLUTION}. The key is created with `Symbol.for(...)` so a
 * plugin integrates WITHOUT importing this package (it re-derives the identical
 * symbol):
 *
 * ```ts
 * const resolution = app.runWithContext(() =>
 *   inject<SsrRequestResolution | null>(
 *     Symbol.for('vue-ssr:request-resolution'),
 *     null,
 *   )
 * )
 * resolution?.track(client.query(...))
 * ```
 *
 * Request-local external stores that participate in automatic watcher/effect
 * reconciliation should contribute their serializable state through the
 * hydration controller. That contribution becomes part of the request-owned
 * render checkpoint used to distinguish replay from a new consequence.
 *
 * The contract is API-client neutral: it never inspects the work it is handed.
 */
export interface SsrRequestResolution {
  /** True while server-rendering, false during browser hydration / SPA mount. */
  readonly server: boolean
  /** Zero-based index of the render pass currently in progress. */
  readonly pass: number
  /**
   * Register in-flight async work the renderer must await before it serializes
   * the response. Returns the same promise for convenient chaining. Ignored in
   * the browser, where there is no server render to gate. Rejections are
   * swallowed by the renderer's await — the component tree owns error surfacing.
   * Tracking alone does not invalidate rendered HTML; call
   * {@link requestAdditionalPass} when settlement changes render-visible state.
   */
  track<T>(work: Promise<T>): Promise<T>
  /**
   * Request one additional render pass even when no tracked promise is pending.
   * Use when work mutated shared state synchronously in a way the current tree
   * did not observe. Honoured up to the configured pass bound. The {@link
   * ssrWatch} primitive calls this automatically, so applications rarely call it
   * directly.
   */
  requestAdditionalPass(): void
}

/**
 * Cross-package-stable injection key for {@link SsrRequestResolution}. Uses the
 * global symbol registry so integrations resolve the same identity whether or
 * not they import `vue-ssr-lite`.
 */
export const SSR_REQUEST_RESOLUTION = Symbol.for(
  'vue-ssr:request-resolution'
) as InjectionKey<SsrRequestResolution>

/**
 * Resolve the active {@link SsrRequestResolution} from component setup. Returns
 * `null` when no SSR host is installed (a plain SPA), so callers can no-op.
 *
 * The canonical use is the "parent query → child components → child queries via
 * an external store read by a sibling" pattern: a component that hydrates async
 * server data into a shared store (read by a sibling that Vue renders without
 * awaiting this component's prefetch) calls `requestAdditionalPass()` so the
 * renderer produces one more pass. On the next pass the data is warm in the
 * request cache and hydrates synchronously at setup, so the sibling sees it. All
 * of this is inert in the browser.
 */
export const useSsrResolution = (): SsrRequestResolution | null =>
  inject<SsrRequestResolution | null>(SSR_REQUEST_RESOLUTION, null)

export interface SsrResolutionController extends SsrRequestResolution {
  /** Begin a new render pass: clears the additional-pass request flag. */
  beginPass(pass: number): void
  /** Register a watcher source; ambiguous slot layouts are never deduplicated. */
  registerReactivitySource(
    identity?: string,
    deduplicable?: boolean
  ): SsrReactivitySource
  /** Request reconciliation for one watcher transition and its callback baseline. */
  requestReactivityPass(
    source: SsrReactivitySource,
    transition: string | null,
    beforeCheckpoint?: string | null
  ): void
  /** Snapshot the current request-owned render state at a callback boundary. */
  reactivityCheckpoint(): string | null
  /** Install the current application's render-state checkpoint reader. */
  setReactivityCheckpointReader(reader: (() => string) | null): void
  /** Record one request dependency result and how to read it at pass completion. */
  registerReactivityObservation(
    observed?: string | null,
    readTerminal?: () => string | null
  ): void
  /** Stop accepting render observations after Vue finishes the current HTML. */
  completeReactivityObservation(): void
  /** Suppress callback-internal reads from render-observation accounting. */
  beginReactivityCallback(): void
  endReactivityCallback(): void
  /** Request reconciliation for one effect invalidation consequence. */
  requestReactivityEffectPass(source: SsrReactivitySource): void
  /** Finalize structural reactivity bookkeeping for the completed pass. */
  completeReactivityPass(): void
  /** Promises registered during the current request that are not yet settled. */
  pendingWork(): Promise<unknown>[]
  /** True when a plugin explicitly asked for another pass this render. */
  additionalPassRequested(): boolean
  /**
   * Await all currently-tracked work, bounded by `deadlineMs` and aborted by
   * `signal`. Returns `true` when everything settled within the deadline.
   */
  drain(deadlineMs: number, signal?: AbortSignal): Promise<boolean>
  /** Clear all state and stop accepting work. Called after the final pass. */
  dispose(): void
}

export interface SsrReactivitySource {
  readonly identity: string
  readonly slot: number
  readonly deduplicable: boolean
}

export const registerSsrReactivitySource = (
  resolution: SsrRequestResolution,
  identity?: string,
  deduplicable?: boolean
): SsrReactivitySource | null => {
  const controller = resolution as Partial<SsrResolutionController>
  return typeof controller.registerReactivitySource === 'function'
    ? controller.registerReactivitySource(identity, deduplicable)
    : null
}

const normalizeExactValue = (
  value: unknown,
  ancestors: WeakSet<object>
): unknown | null => {
  if (value === null) return ['null']
  if (value === undefined) return ['undefined']
  if (typeof value === 'string') return ['string', value]
  if (typeof value === 'boolean') return ['boolean', value]
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['number', 'NaN']
    if (value === Infinity) return ['number', 'Infinity']
    if (value === -Infinity) return ['number', '-Infinity']
    if (Object.is(value, -0)) return ['number', '-0']
    return ['number', value]
  }
  if (typeof value === 'bigint') return ['bigint', String(value)]
  if (typeof value !== 'object') return null
  if (ancestors.has(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return null
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value)
      if (
        ownKeys.some(
          (key) =>
            typeof key === 'symbol' ||
            (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))
        )
      ) {
        return null
      }
      const items: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) return null
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !('value' in descriptor)) return null
        const normalized = normalizeExactValue(descriptor.value, ancestors)
        if (normalized === null) return null
        items.push(normalized)
      }
      return ['array', items]
    }
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some((key) => typeof key === 'symbol')) return null
    const entries: unknown[] = []
    for (const key of (ownKeys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) return null
      const normalized = normalizeExactValue(
        descriptor.value,
        ancestors
      )
      if (normalized === null) return null
      entries.push([
        key,
        descriptor.enumerable,
        descriptor.configurable,
        descriptor.writable,
        normalized,
      ])
    }
    return ['object', entries]
  } finally {
    ancestors.delete(value)
  }
}

export const fingerprintSsrReactivityValues = (
  values: readonly unknown[]
): string | null => {
  try {
    const normalized = normalizeExactValue(values, new WeakSet())
    return normalized === null ? null : JSON.stringify(normalized)
  } catch {
    return null
  }
}

/**
 * Internal bridge used by `ssrWatch` and `ssrWatchEffect`. Recreated instances
 * are coalesced directly only when both source ownership and transition values
 * are exact. Ambiguous callbacks consume the prior pass's ordered group
 * obligations. Pass completion also accounts for inherited obligations that
 * did not recur and request-state observations around every automatic
 * reactivity callback, using adjacent request-state checkpoints rather than
 * blind ordering or raw callback-count equality.
 */
export const requestSsrReactivityPass = (
  resolution: SsrRequestResolution,
  source: SsrReactivitySource | null,
  values: readonly unknown[] | null,
  beforeCheckpoint?: string | null
): void => {
  const controller = resolution as Partial<SsrResolutionController>
  if (source && typeof controller.requestReactivityPass === 'function') {
    controller.requestReactivityPass(
      source,
      values === null ? null : fingerprintSsrReactivityValues(values),
      beforeCheckpoint
    )
    return
  }
  resolution.requestAdditionalPass()
}

export const requestSsrReactivityEffectPass = (
  resolution: SsrRequestResolution,
  source: SsrReactivitySource | null
): void => {
  const controller = resolution as Partial<SsrResolutionController>
  if (source && typeof controller.requestReactivityEffectPass === 'function') {
    controller.requestReactivityEffectPass(source)
    return
  }
  resolution.requestAdditionalPass()
}

interface TrackedWork {
  readonly promise: Promise<unknown>
  settled: boolean
}

const NO_CALLBACK_CONSEQUENCE = Symbol('no-callback-consequence')
type ReactivityConsequence = string | typeof NO_CALLBACK_CONSEQUENCE
type CheckpointCounts = Map<ReactivityConsequence, number>
type SlotCheckpointCounts = Map<number, CheckpointCounts>
type ExactWatchCheckpointCounts = Map<
  string,
  Map<number, Map<string, CheckpointCounts>>
>
type SsrReactivityKind = 'watch' | 'effect'
interface AmbiguousReactivityCheckpoint {
  readonly kind: SsrReactivityKind
  readonly checkpoint: string
}
interface ObservableReactivityCallback extends AmbiguousReactivityCheckpoint {
  readonly type: 'callback'
  readonly ownership: 'exact' | 'ambiguous'
  readonly identity: string
  readonly slot: number | null
  readonly transition: string | null
}
interface ObservableReactivityObservation {
  readonly type: 'observation'
  readonly observed: string | null
  readonly readTerminal: () => string | null
}
type ObservableSsrEvent =
  | ObservableReactivityCallback
  | ObservableReactivityObservation

const recordCheckpoint = (
  counts: CheckpointCounts,
  checkpoint: ReactivityConsequence
): number => {
  const count = (counts.get(checkpoint) ?? 0) + 1
  counts.set(checkpoint, count)
  return count
}

const hasUnconsumedCheckpoints = (
  previous: CheckpointCounts,
  current: CheckpointCounts | undefined
): boolean => {
  for (const [checkpoint, previousCount] of previous) {
    if ((current?.get(checkpoint) ?? 0) < previousCount) return true
  }
  return false
}

const hasUnconsumedExactWatchCheckpoints = (
  previous: ExactWatchCheckpointCounts,
  current: ExactWatchCheckpointCounts
): boolean => {
  for (const [identity, previousSlots] of previous) {
    const currentSlots = current.get(identity)
    for (const [slot, previousTransitions] of previousSlots) {
      const currentTransitions = currentSlots?.get(slot)
      for (const [transition, previousCheckpoints] of previousTransitions) {
        if (
          hasUnconsumedCheckpoints(
            previousCheckpoints,
            currentTransitions?.get(transition)
          )
        ) {
          return true
        }
      }
    }
  }
  return false
}

const hasUnconsumedExactEffectCheckpoints = (
  previous: Map<string, SlotCheckpointCounts>,
  current: Map<string, SlotCheckpointCounts>
): boolean => {
  for (const [identity, previousSlots] of previous) {
    const currentSlots = current.get(identity)
    for (const [slot, previousCheckpoints] of previousSlots) {
      if (
        hasUnconsumedCheckpoints(previousCheckpoints, currentSlots?.get(slot))
      ) {
        return true
      }
    }
  }
  return false
}

const sameAmbiguousCheckpoint = (
  current: AmbiguousReactivityCheckpoint,
  previous: AmbiguousReactivityCheckpoint | undefined
): boolean =>
  current.kind === previous?.kind && current.checkpoint === previous.checkpoint

const hasUnconsumedAmbiguousCheckpoints = (
  previous: Map<string, AmbiguousReactivityCheckpoint[]>,
  current: Map<string, AmbiguousReactivityCheckpoint[]>
): boolean => {
  for (const [identity, previousCheckpoints] of previous) {
    if ((current.get(identity)?.length ?? 0) < previousCheckpoints.length) {
      return true
    }
  }
  return false
}

const sameObservableCallback = (
  current: ObservableReactivityCallback,
  previous: ObservableReactivityCallback | undefined
): boolean => {
  if (!previous) return false
  return (
    sameAmbiguousCheckpoint(current, previous) &&
    current.ownership === previous.ownership &&
    current.identity === previous.identity &&
    current.slot === previous.slot &&
    current.transition === previous.transition
  )
}

const hasObservableOrderingChange = (
  previous: ObservableSsrEvent[],
  current: ObservableSsrEvent[]
): boolean => {
  const previousCallbacks = previous.filter(
    (event): event is ObservableReactivityCallback => event.type === 'callback'
  )
  const currentCallbacks = current.filter(
    (event): event is ObservableReactivityCallback => event.type === 'callback'
  )
  // A shorter generation is missing-obligation evidence, not reordering; a
  // longer generation already requests a pass when its new callback is
  // registered. Only equal-cardinality permutations need the ordering proof.
  return (
    previousCallbacks.length === currentCallbacks.length &&
    currentCallbacks.some((checkpoint, index) =>
      !sameObservableCallback(checkpoint, previousCallbacks[index])
    )
  )
}

const hasUnstableObservedVisibility = (events: ObservableSsrEvent[]): boolean =>
  events.some((event) => {
    if (event.type !== 'observation') return false
    try {
      return event.observed !== event.readTerminal()
    } catch {
      return true
    }
  })

const isThenable = (value: unknown): value is Promise<unknown> =>
  Boolean(value) &&
  (typeof value === 'object' || typeof value === 'function') &&
  typeof (value as { then?: unknown }).then === 'function'

/**
 * Creates the per-request resolution controller. Reused across every render
 * pass of a single request so tracked work and pass requests accumulate
 * coherently while the Vue application itself is recreated per pass.
 *
 * Reconciliation invariant:
 * - The inherited accepted state is the prior pass's terminal full-request
 *   checkpoint; callback obligations prove whether the new terminal state is
 *   a replay of it or a new consequence.
 * - A render-visible read records the semantic result of its exact dependency
 *   operation, not the state of unrelated request fields.
 * - A read whose result differs from that same dependency's completed-pass
 *   result proves HTML saw an intermediate value and requires reconciliation.
 * - Writes may move away from and return to the accepted state before a read;
 *   equality at the read is sufficient and needs no confirmation pass.
 * - Automatic reads and writes cover request-owned plain objects, arrays,
 *   Maps, and Sets. Other mutable containers and opaque external state require
 *   an explicit pass request.
 * - Stable replay converges because checkpoint equality is semantic; it does
 *   not compare a monotonically increasing write count across applications.
 */
export const createSsrResolutionController = (
  server: boolean = typeof window === 'undefined'
): SsrResolutionController => {
  const tracked = new Set<TrackedWork>()
  let pass = 0
  let passRequested = false
  let reactivityRegistrations = new Map<string, number>()
  const ambiguousReactivityIdentities = new Set<string>()
  let previousReactivityRegistrations = new Map<string, number>()
  const passAmbiguousReactivityIdentities = new Set<string>()
  let reactivityCheckpointReader: (() => string) | null = null
  let previousCompletedCheckpoint: string | null = null
  let previousExactWatchCheckpoints: ExactWatchCheckpointCounts = new Map()
  let currentExactWatchCheckpoints: ExactWatchCheckpointCounts = new Map()
  let previousObservableEvents: ObservableSsrEvent[] = []
  let currentObservableEvents: ObservableSsrEvent[] = []
  let previousAmbiguousCheckpoints = new Map<
    string,
    AmbiguousReactivityCheckpoint[]
  >()
  let currentAmbiguousCheckpoints = new Map<
    string,
    AmbiguousReactivityCheckpoint[]
  >()
  let previousExactEffectCheckpoints = new Map<string, SlotCheckpointCounts>()
  let currentExactEffectCheckpoints = new Map<string, SlotCheckpointCounts>()
  let reactivityCallbackDepth = 0
  let reactivityObservationOpen = server
  let disposed = false

  const controller: SsrResolutionController = {
    server,
    get pass() {
      return pass
    },
    track: <T>(work: Promise<T>): Promise<T> => {
      if (!server || disposed || !isThenable(work)) return work
      const entry: TrackedWork = { promise: work, settled: false }
      tracked.add(entry)
      // Mark settled without swallowing the original rejection for callers that
      // await the returned promise directly.
      work.then(
        () => {
          entry.settled = true
        },
        () => {
          entry.settled = true
        }
      )
      return work
    },
    requestAdditionalPass: () => {
      if (server && !disposed) passRequested = true
    },
    beginPass: (nextPass: number) => {
      if (disposed) return
      pass = nextPass
      passRequested = false
      reactivityRegistrations = new Map()
      passAmbiguousReactivityIdentities.clear()
      reactivityCheckpointReader = null
      currentObservableEvents = []
      reactivityCallbackDepth = 0
      reactivityObservationOpen = true
    },
    registerReactivitySource: (identity, deduplicable = false) => {
      const resolvedIdentity = identity || 'anonymous'
      const slot = reactivityRegistrations.get(resolvedIdentity) ?? 0
      reactivityRegistrations.set(resolvedIdentity, slot + 1)
      if (slot > 0) ambiguousReactivityIdentities.add(resolvedIdentity)
      return {
        identity: resolvedIdentity,
        slot,
        deduplicable,
      }
    },
    requestReactivityPass: (source, transition, beforeCheckpoint) => {
      if (!server || disposed) return
      const checkpoint = controller.reactivityCheckpoint()
      if (
        !source.deduplicable ||
        transition === null ||
        ambiguousReactivityIdentities.has(source.identity)
      ) {
        passAmbiguousReactivityIdentities.add(source.identity)
        if (checkpoint === null) {
          passRequested = true
          return
        }
        let checkpoints = currentAmbiguousCheckpoints.get(source.identity)
        if (!checkpoints) {
          checkpoints = []
          currentAmbiguousCheckpoints.set(source.identity, checkpoints)
        }
        // This is one group-level observable sequence across watchers and
        // effects, not component-slot identity. Cross-kind reordering remains
        // a new consequence even when each primitive's checkpoints are stable.
        const event = { kind: 'watch' as const, checkpoint }
        const sequenceIndex = checkpoints.push(event) - 1
        currentObservableEvents.push({
          type: 'callback',
          ownership: 'ambiguous',
          kind: 'watch',
          identity: source.identity,
          slot: null,
          transition: null,
          checkpoint,
        })
        const obligation =
          previousAmbiguousCheckpoints.get(source.identity)?.[
            sequenceIndex
          ]
        if (!sameAmbiguousCheckpoint(event, obligation)) passRequested = true
        return
      }
      if (checkpoint === null) {
        passRequested = true
        return
      }
      // A callback that leaves the request-owned checkpoint untouched has no
      // render consequence of its own. Match that no-op independently of the
      // surrounding baseline: an unrelated watcher may have warmed another
      // request field before this exact transition replays. Callbacks that do
      // change state retain their absolute post-callback checkpoint so a same
      // transition with a genuinely new consequence remains eligible.
      const consequence =
        beforeCheckpoint != null && beforeCheckpoint === checkpoint
          ? NO_CALLBACK_CONSEQUENCE
          : checkpoint
      let sourceCheckpoints = currentExactWatchCheckpoints.get(source.identity)
      if (!sourceCheckpoints) {
        sourceCheckpoints = new Map()
        currentExactWatchCheckpoints.set(source.identity, sourceCheckpoints)
      }
      let transitionCheckpoints = sourceCheckpoints.get(source.slot)
      if (!transitionCheckpoints) {
        transitionCheckpoints = new Map()
        sourceCheckpoints.set(source.slot, transitionCheckpoints)
      }
      let checkpoints = transitionCheckpoints.get(transition)
      if (!checkpoints) {
        checkpoints = new Map()
        transitionCheckpoints.set(transition, checkpoints)
      }
      const occurrence = recordCheckpoint(checkpoints, consequence)
      currentObservableEvents.push({
        type: 'callback',
        ownership: 'exact',
        kind: 'watch',
        identity: source.identity,
        slot: source.slot,
        transition,
        checkpoint,
      })
      const previousCheckpoints =
        previousExactWatchCheckpoints
          .get(source.identity)
          ?.get(source.slot)
          ?.get(transition)
      const obligation = previousCheckpoints?.get(consequence) ?? 0
      // A newly discovered callback remains eligible because request-owned
      // checkpoints cannot account for component-local render state. Once the
      // same exact transition has an adjacent-generation obligation, however,
      // its recorded no-op has no independent render consequence.
      if (
        consequence === NO_CALLBACK_CONSEQUENCE
          ? previousCheckpoints === undefined
          : occurrence > obligation
      ) {
        passRequested = true
      }
    },
    reactivityCheckpoint: () => {
      if (!server || disposed || !reactivityCheckpointReader) return null
      reactivityCallbackDepth += 1
      try {
        return reactivityCheckpointReader()
      } catch {
        return null
      } finally {
        reactivityCallbackDepth -= 1
      }
    },
    setReactivityCheckpointReader: (reader) => {
      if (!disposed) reactivityCheckpointReader = reader
    },
    registerReactivityObservation: (observed, readTerminal) => {
      if (
        server &&
        !disposed &&
        reactivityObservationOpen &&
        reactivityCallbackDepth === 0
      ) {
        const resolvedObserved =
          observed === undefined ? controller.reactivityCheckpoint() : observed
        const resolvedReadTerminal =
          readTerminal ?? (() => controller.reactivityCheckpoint())
        const previous = currentObservableEvents[currentObservableEvents.length - 1]
        if (
          previous?.type !== 'observation' ||
          previous.observed !== resolvedObserved ||
          previous.readTerminal !== resolvedReadTerminal
        ) {
          currentObservableEvents.push({
            type: 'observation',
            observed: resolvedObserved,
            readTerminal: resolvedReadTerminal,
          })
        }
      }
    },
    completeReactivityObservation: () => {
      reactivityObservationOpen = false
    },
    beginReactivityCallback: () => {
      if (server && !disposed) reactivityCallbackDepth += 1
    },
    endReactivityCallback: () => {
      if (server && !disposed && reactivityCallbackDepth > 0) {
        reactivityCallbackDepth -= 1
      }
    },
    requestReactivityEffectPass: (source) => {
      if (!server || disposed) return
      const checkpoint = controller.reactivityCheckpoint()
      if (checkpoint === null) {
        passRequested = true
        return
      }
      if (
        source.deduplicable &&
        !ambiguousReactivityIdentities.has(source.identity)
      ) {
        let sourceCheckpoints = currentExactEffectCheckpoints.get(source.identity)
        if (!sourceCheckpoints) {
          sourceCheckpoints = new Map()
          currentExactEffectCheckpoints.set(source.identity, sourceCheckpoints)
        }
        let checkpoints = sourceCheckpoints.get(source.slot)
        if (!checkpoints) {
          checkpoints = new Map()
          sourceCheckpoints.set(source.slot, checkpoints)
        }
        const occurrence = recordCheckpoint(checkpoints, checkpoint)
        currentObservableEvents.push({
          type: 'callback',
          ownership: 'exact',
          kind: 'effect',
          identity: source.identity,
          slot: source.slot,
          transition: null,
          checkpoint,
        })
        const obligation =
          previousExactEffectCheckpoints
            .get(source.identity)
            ?.get(source.slot)
            ?.get(checkpoint) ?? 0
        if (occurrence <= obligation) return
      } else {
        passAmbiguousReactivityIdentities.add(source.identity)
        let checkpoints = currentAmbiguousCheckpoints.get(source.identity)
        if (!checkpoints) {
          checkpoints = []
          currentAmbiguousCheckpoints.set(source.identity, checkpoints)
        }
        const event = { kind: 'effect' as const, checkpoint }
        const sequenceIndex = checkpoints.push(event) - 1
        currentObservableEvents.push({
          type: 'callback',
          ownership: 'ambiguous',
          kind: 'effect',
          identity: source.identity,
          slot: null,
          transition: null,
          checkpoint,
        })
        const obligation =
          previousAmbiguousCheckpoints.get(source.identity)?.[
            sequenceIndex
          ]
        if (sameAmbiguousCheckpoint(event, obligation)) return
      }
      passRequested = true
    },
    completeReactivityPass: () => {
      if (!server || disposed) return
      const hasPreviousReactivityObligations =
        previousExactWatchCheckpoints.size > 0 ||
        previousAmbiguousCheckpoints.size > 0 ||
        previousExactEffectCheckpoints.size > 0
      const hasCurrentReactivityObligations =
        currentExactWatchCheckpoints.size > 0 ||
        currentAmbiguousCheckpoints.size > 0 ||
        currentExactEffectCheckpoints.size > 0
      const hasReactivityObligations =
        hasPreviousReactivityObligations || hasCurrentReactivityObligations
      const completedCheckpoint = hasReactivityObligations
        ? controller.reactivityCheckpoint()
        : null
      for (const identity of passAmbiguousReactivityIdentities) {
        const previousCount = previousReactivityRegistrations.get(identity)
        const currentCount = reactivityRegistrations.get(identity) ?? 0
        if (previousCount !== undefined && previousCount !== currentCount) {
          passRequested = true
        }
      }
      const hasUnconsumedObligations =
        hasUnconsumedExactWatchCheckpoints(
          previousExactWatchCheckpoints,
          currentExactWatchCheckpoints
        ) ||
        hasUnconsumedExactEffectCheckpoints(
          previousExactEffectCheckpoints,
          currentExactEffectCheckpoints
        ) ||
        hasUnconsumedAmbiguousCheckpoints(
          previousAmbiguousCheckpoints,
          currentAmbiguousCheckpoints
        )
      const observableOrderingChanged =
        hasReactivityObligations &&
        hasObservableOrderingChange(
          previousObservableEvents,
          currentObservableEvents
        )
      const stableCallbackBoundaries =
        previousCompletedCheckpoint !== null &&
        completedCheckpoint === previousCompletedCheckpoint &&
        currentObservableEvents.every(
          (event) =>
            event.type === 'observation' ||
            event.checkpoint === previousCompletedCheckpoint
        )
      const unstableObservedVisibility =
        hasReactivityObligations &&
        hasUnstableObservedVisibility(currentObservableEvents)
      const terminalCheckpointChanged =
        previousCompletedCheckpoint === null ||
        completedCheckpoint === null ||
        previousCompletedCheckpoint !== completedCheckpoint
      if (
        (hasUnconsumedObligations && terminalCheckpointChanged) ||
        (observableOrderingChanged && !stableCallbackBoundaries) ||
        unstableObservedVisibility
      ) {
        // Missing obligations still use terminal consequence equality.
        // Callback reordering needs the stronger proof that every callback
        // boundary remained at the inherited terminal checkpoint. Consumer
        // placement does not need an ordering heuristic: each request-state
        // observation carries direct semantic proof of the state HTML saw.
        passRequested = true
      }
      previousCompletedCheckpoint = hasCurrentReactivityObligations
        ? completedCheckpoint
        : null
      previousReactivityRegistrations = new Map(reactivityRegistrations)
      previousExactWatchCheckpoints = currentExactWatchCheckpoints
      currentExactWatchCheckpoints = new Map()
      previousObservableEvents = hasCurrentReactivityObligations
        ? currentObservableEvents
        : []
      currentObservableEvents = []
      previousAmbiguousCheckpoints = currentAmbiguousCheckpoints
      currentAmbiguousCheckpoints = new Map()
      previousExactEffectCheckpoints = currentExactEffectCheckpoints
      currentExactEffectCheckpoints = new Map()
      reactivityCallbackDepth = 0
      reactivityObservationOpen = false
    },
    pendingWork: () =>
      disposed ? [] : [...tracked].filter((entry) => !entry.settled).map((entry) => entry.promise),
    additionalPassRequested: () => !disposed && passRequested,
    drain: async (deadlineMs: number, signal?: AbortSignal): Promise<boolean> => {
      const hasDeadline = Number.isFinite(deadlineMs) && deadlineMs > 0
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const guard =
        hasDeadline || signal
          ? new Promise<false>((resolvePromise) => {
              if (hasDeadline) {
                timer = setTimeout(() => resolvePromise(false), deadlineMs)
              }
              if (signal) {
                onAbort = () => resolvePromise(false)
                if (signal.aborted) resolvePromise(false)
                else signal.addEventListener('abort', onAbort, { once: true })
              }
            })
          : undefined
      try {
        // Work tracked while awaiting (a resolving promise starting the next
        // link of a waterfall) is included until nothing is left pending. Race
        // each generation so cancellation stops advancing the drain loop.
        while (true) {
          const pending = controller.pendingWork()
          if (pending.length === 0) return true
          const settled = guard
            ? await Promise.race([
                Promise.allSettled(pending).then(() => true as const),
                guard,
              ])
            : await Promise.allSettled(pending).then(() => true as const)
          if (!settled) return false
        }
      } finally {
        if (timer) clearTimeout(timer)
        if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      }
    },
    dispose: () => {
      disposed = true
      tracked.clear()
      passRequested = false
      reactivityRegistrations = new Map()
      previousReactivityRegistrations = new Map()
      passAmbiguousReactivityIdentities.clear()
      reactivityCheckpointReader = null
      previousCompletedCheckpoint = null
      previousExactWatchCheckpoints = new Map()
      currentExactWatchCheckpoints = new Map()
      previousObservableEvents = []
      currentObservableEvents = []
      previousAmbiguousCheckpoints = new Map()
      currentAmbiguousCheckpoints = new Map()
      previousExactEffectCheckpoints = new Map()
      currentExactEffectCheckpoints = new Map()
      reactivityCallbackDepth = 0
      reactivityObservationOpen = false
      ambiguousReactivityIdentities.clear()
      pass = 0
    },
  }
  return controller
}
