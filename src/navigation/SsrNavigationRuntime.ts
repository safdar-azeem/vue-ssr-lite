import { nextTick, type InjectionKey } from 'vue'
import {
  START_LOCATION,
  type RouteLocationMatched,
  type RouteLocationNormalized,
  type RouteLocationNormalizedLoaded,
  type Router,
} from 'vue-router'
import type {
  SsrNavigationBoundarySubscriber,
  SsrNavigationRuntime,
  SsrNavigationSubscriber,
  SsrNavigationTransaction,
} from './SsrNavigationTypes'

type NavigationOutcome = 'success' | 'cancelled' | 'error' | 'dispose'

export const SSR_NAVIGATION_RUNTIME: InjectionKey<SsrNavigationRuntime> =
  Symbol('vue-ssr-lite navigation runtime')

const canonicalRecord = (record: RouteLocationMatched | undefined) =>
  record?.aliasOf ?? record

export const resolveFirstChangedRouteDepth = (
  from: RouteLocationNormalizedLoaded,
  to: RouteLocationNormalized
): number => {
  const length = Math.max(from.matched.length, to.matched.length)
  for (let depth = 0; depth < length; depth += 1) {
    if (
      canonicalRecord(from.matched[depth]) !== canonicalRecord(to.matched[depth])
    ) {
      return depth
    }
  }

  // Params, query, and hash changes can reuse every matched route record. The
  // deepest outlet is the narrowest useful boundary for those navigations.
  return Math.max(0, to.matched.length - 1)
}

interface ActiveNavigation {
  transaction: SsrNavigationTransaction
  /** First target in this router-owned redirect chain. */
  origin: RouteLocationNormalized
  readiness: PageReadiness
  boundaries: Set<SsrNavigationBoundarySubscriber>
  pendingBoundaries: Set<SsrNavigationBoundarySubscriber>
  routerAccepted: boolean
  terminalOutcome: NavigationOutcome
}

interface PageReadiness {
  readonly promise: Promise<boolean>
  resolve(ready: boolean): void
}

const createPageReadiness = (): PageReadiness => {
  let settled = false
  let resolvePromise!: (ready: boolean) => void
  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(ready) {
      if (settled) return
      settled = true
      resolvePromise(ready)
    },
  }
}

export const createSsrNavigationRuntime = (options: {
  router: Router
  server: boolean
  diagnostics?: boolean
}): SsrNavigationRuntime => {
  const subscribers = new Set<SsrNavigationSubscriber>()
  const boundaries = new Map<number, Set<SsrNavigationBoundarySubscriber>>()
  const navigationIds = new WeakMap<object, number>()
  const pageReadiness = new WeakMap<object, PageReadiness>()
  let boundaryCount = 0
  let sequence = 0
  let active: ActiveNavigation | undefined
  let initialNavigationPending =
    options.router.currentRoute.value === START_LOCATION
  let disposed = false

  const selectBoundaries = (
    changedDepth: number
  ): Set<SsrNavigationBoundarySubscriber> => {
    for (let depth = changedDepth; depth >= 0; depth -= 1) {
      const candidates = boundaries.get(depth)
      if (candidates?.size) return new Set(candidates)
    }
    return new Set()
  }

  const trace = (
    transaction: SsrNavigationTransaction,
    event: 'START' | 'REDIRECT' | 'SUPERSEDED' | 'SETTLE',
    outcome?: NavigationOutcome
  ) => {
    if (!options.diagnostics) return
    const suffix = outcome ? ` ${outcome}` : ''
    console.debug(
      `[vue-ssr-lite] navigation #${transaction.id} ${event}${suffix}`,
      {
        from: transaction.from.fullPath,
        to: transaction.to.fullPath,
      }
    )
  }

  const settle = (transactionId: number, outcome: NavigationOutcome) => {
    if (active?.transaction.id !== transactionId) return
    const current = active
    active = undefined
    current.readiness.resolve(
      outcome === 'success' &&
        options.router.currentRoute.value === current.transaction.to
    )
    trace(current.transaction, 'SETTLE', outcome)
    for (const subscriber of subscribers) {
      subscriber.settle(transactionId)
    }
    for (const boundary of current.boundaries) {
      boundary.settle(transactionId)
    }
  }

  const accept = (transactionId: number) => {
    if (active?.transaction.id !== transactionId || active.routerAccepted) {
      return
    }
    const current = active
    current.routerAccepted = true
    current.terminalOutcome = 'success'
    current.pendingBoundaries = new Set()
    for (const boundary of current.boundaries) {
      if (boundary.accept(current.transaction)) {
        current.pendingBoundaries.add(boundary)
      }
    }
    if (!current.pendingBoundaries.size) {
      void nextTick(() => settle(transactionId, 'success'))
    }
  }

  const abort = (
    transactionId: number,
    outcome: Extract<NavigationOutcome, 'cancelled' | 'error'>
  ) => {
    if (active?.transaction.id !== transactionId) return
    const current = active
    const pendingBoundaries = new Set<SsrNavigationBoundarySubscriber>()
    for (const boundary of current.boundaries) {
      if (boundary.abort(transactionId)) pendingBoundaries.add(boundary)
    }
    if (!pendingBoundaries.size) {
      settle(transactionId, outcome)
      return
    }

    // The rejected target has no page ownership. A previously committed page
    // may nevertheless still be resolving (for example Products -> guarded
    // route -> cancellation). Keep the same visual clock attached to that
    // current page without waiting on work from the rejected destination.
    current.routerAccepted = true
    current.terminalOutcome = outcome
    current.pendingBoundaries = pendingBoundaries
  }

  const replaceActive = (transaction: SsrNavigationTransaction) => {
    const nextBoundaries = selectBoundaries(transaction.changedDepth)
    const previous = active
    const readiness = createPageReadiness()
    active = {
      transaction,
      origin: transaction.to,
      readiness,
      boundaries: nextBoundaries,
      pendingBoundaries: new Set(),
      routerAccepted: false,
      terminalOutcome: 'success',
    }

    if (previous) {
      previous.readiness.resolve(false)
      trace(previous.transaction, 'SUPERSEDED')
    }
    trace(transaction, 'START')
    for (const subscriber of subscribers) subscriber.start(transaction)
    for (const boundary of nextBoundaries) boundary.start(transaction)
    if (previous) {
      // Transfer ownership first, then terminate the old generation. Shared
      // subscribers ignore the stale ID, preserving an elapsed delay or an
      // already-visible loader while every START still has one logical end.
      for (const subscriber of subscribers) {
        subscriber.settle(previous.transaction.id)
      }
      for (const boundary of previous.boundaries) {
        boundary.settle(previous.transaction.id)
      }
    }
  }

  const retargetActive = (
    current: ActiveNavigation,
    to: RouteLocationNormalized,
    changedDepth: number
  ) => {
    const transaction = current.transaction
    transaction.to = to
    transaction.changedDepth = changedDepth
    const nextBoundaries = selectBoundaries(changedDepth)
    active = {
      transaction,
      origin: current.origin,
      readiness: current.readiness,
      boundaries: nextBoundaries,
      pendingBoundaries: new Set(),
      routerAccepted: false,
      terminalOutcome: 'success',
    }
    trace(transaction, 'REDIRECT')

    // Retarget continuing owners and start new ones before releasing old ones,
    // preserving both branch ownership and the logical loading clock.
    for (const boundary of nextBoundaries) {
      if (current.boundaries.has(boundary)) boundary.retarget?.(transaction)
      else boundary.start(transaction)
    }
    for (const boundary of current.boundaries) {
      if (!nextBoundaries.has(boundary)) {
        boundary.settle(transaction.id)
      }
    }
    return transaction
  }

  const refreshActiveBoundaries = () => {
    if (!active) return
    const current = active
    const previousBoundaries = current.boundaries
    const nextBoundaries = selectBoundaries(
      current.transaction.changedDepth
    )
    current.boundaries = nextBoundaries
    for (const boundary of nextBoundaries) {
      if (!previousBoundaries.has(boundary)) {
        boundary.start(current.transaction)
        if (current.routerAccepted) {
          if (boundary.accept(current.transaction)) {
            current.pendingBoundaries.add(boundary)
          }
        }
      }
    }
    for (const boundary of previousBoundaries) {
      if (!nextBoundaries.has(boundary)) {
        current.pendingBoundaries.delete(boundary)
        boundary.settle(current.transaction.id)
      }
    }
    if (current.routerAccepted && !current.pendingBoundaries.size) {
      void nextTick(() =>
        settle(current.transaction.id, current.terminalOutcome)
      )
    }
  }

  const resolveTerminalTransaction = (
    to: RouteLocationNormalized,
    hook: 'afterEach' | 'onError'
  ): number | undefined => {
    const mapped = navigationIds.get(to)
    if (mapped !== undefined) return mapped
    if (!active) return undefined

    // Vue Router may terminate a redirect as duplicated before running the
    // redirect target through beforeEach when that target is already current.
    // In that case the terminal route has no navigationIds entry and active
    // still points at the pre-redirect target. Redirect ancestry is the
    // ownership proof that lets this terminal event close the same logical
    // transaction without weakening stale-generation checks.
    const redirectOrigin = to.redirectedFrom
    const redirectOriginId = redirectOrigin
      ? navigationIds.get(redirectOrigin)
      : undefined
    if (
      redirectOrigin?.fullPath === active.origin.fullPath &&
      redirectOriginId === active.transaction.id
    ) {
      if (options.diagnostics) {
        console.debug(
          `[vue-ssr-lite] navigation #${active.transaction.id} recovered terminal ownership from ${hook} redirect ancestry.`,
          {
            to: to.fullPath,
            redirectedFrom: redirectOrigin.fullPath,
          }
        )
      }
      return active.transaction.id
    }

    // A terminal hook for a superseded route must never settle the newer
    // active generation. Its own mapped ID normally takes the branch above;
    // an equivalent cloned stale route is safe to ignore and is observable in
    // development instead of silently being mistaken for the current owner.
    if (options.diagnostics) {
      console.warn(
        `[vue-ssr-lite] ignored unmapped stale ${hook} navigation while #${active.transaction.id} remains active.`,
        { staleTo: to.fullPath, activeTo: active.transaction.to.fullPath }
      )
    }
    return undefined
  }

  const removeBefore = options.server
    ? () => undefined
    : options.router.beforeEach((to, from) => {
        if (disposed) return true
        if (initialNavigationPending && from === START_LOCATION) return true
        // With no mounted loading UI, the observer performs no route-depth
        // work, reactive writes, timers, or DOM work.
        if (!subscribers.size && boundaryCount === 0) return true

        const changedDepth = resolveFirstChangedRouteDepth(from, to)
        let transaction: SsrNavigationTransaction
        if (
          active &&
          to.redirectedFrom?.fullPath === active.origin.fullPath
        ) {
          transaction = retargetActive(active, to, changedDepth)
        } else {
          transaction = {
            id: ++sequence,
            from,
            to,
            changedDepth,
            startedAt: Date.now(),
          }
          replaceActive(transaction)
        }
        navigationIds.set(to, transaction.id)
        pageReadiness.set(to, active!.readiness)
        return true
      })

  const removeAfter = options.server
    ? () => undefined
    : options.router.afterEach((to, from, failure) => {
        if (initialNavigationPending && from === START_LOCATION) {
          initialNavigationPending = false
        }
        const transactionId = resolveTerminalTransaction(to, 'afterEach')
        if (transactionId === undefined) return
        if (failure) abort(transactionId, 'cancelled')
        else accept(transactionId)
      })

  const removeError = options.server
    ? () => undefined
    : options.router.onError((_error, to, from) => {
        if (initialNavigationPending && from === START_LOCATION) {
          initialNavigationPending = false
        }
        const transactionId = resolveTerminalTransaction(to, 'onError')
        if (transactionId !== undefined) abort(transactionId, 'error')
      })

  return {
    subscribe(subscriber) {
      if (disposed) return () => undefined
      subscribers.add(subscriber)
      if (active) subscriber.start(active.transaction)
      return () => subscribers.delete(subscriber)
    },
    registerBoundary(subscriber) {
      if (disposed) return () => undefined
      let registrations = boundaries.get(subscriber.depth)
      if (!registrations) {
        registrations = new Set()
        boundaries.set(subscriber.depth, registrations)
      }
      if (!registrations.has(subscriber)) {
        registrations.add(subscriber)
        boundaryCount += 1
      }
      refreshActiveBoundaries()
      return () => {
        const registered = boundaries.get(subscriber.depth)
        if (!registered?.delete(subscriber)) return
        boundaryCount -= 1
        if (!registered.size) boundaries.delete(subscriber.depth)
        refreshActiveBoundaries()
      }
    },
    pageReady(transactionId, boundary) {
      if (
        active?.transaction.id !== transactionId ||
        !active.routerAccepted ||
        !active.pendingBoundaries.delete(boundary)
      ) {
        return
      }
      if (!active.pendingBoundaries.size) {
        settle(transactionId, active.terminalOutcome)
      }
    },
    async whenPageReady(route) {
      const readiness = pageReadiness.get(route)
      if (!readiness) return options.router.currentRoute.value === route
      return (
        (await readiness.promise) && options.router.currentRoute.value === route
      )
    },
    isPageCurrent(route) {
      return options.router.currentRoute.value === route
    },
    dispose() {
      if (disposed) return
      disposed = true
      removeBefore()
      removeAfter()
      removeError()
      if (active) settle(active.transaction.id, 'dispose')
      subscribers.clear()
      boundaries.clear()
      boundaryCount = 0
      initialNavigationPending = false
    },
  }
}
