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
  boundaries: Set<SsrNavigationBoundarySubscriber>
  pendingBoundaries: Set<SsrNavigationBoundarySubscriber>
  routerAccepted: boolean
  terminalOutcome: NavigationOutcome
}

interface PageReadiness {
  readonly promise: Promise<boolean>
  resolve(ready: boolean): void
}

interface AcceptedPage {
  readonly route: RouteLocationNormalizedLoaded
  readonly changedDepth: number
  readonly readiness: PageReadiness
  boundaries: Set<SsrNavigationBoundarySubscriber>
  pendingBoundaries: Set<SsrNavigationBoundarySubscriber>
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
  let acceptedPage: AcceptedPage | undefined
  let mounted = false
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

  const finishPageIfReady = (page: AcceptedPage) => {
    if (
      disposed ||
      acceptedPage !== page ||
      page.pendingBoundaries.size ||
      // Initial router acceptance can precede app.mount(). Give enhanced
      // outlets time to register; without one, the root mount is the checkpoint.
      (!mounted && !page.boundaries.size)
    ) {
      return
    }
    page.readiness.resolve(true)
  }

  const acceptPage = (
    route: RouteLocationNormalizedLoaded,
    from: RouteLocationNormalizedLoaded
  ) => {
    if (acceptedPage?.route === route) return
    // Router attempts own loading clocks, not the currently accepted page.
    // Only an actual commit can retire its readiness and pending scroll work.
    acceptedPage?.readiness.resolve(false)
    const changedDepth = resolveFirstChangedRouteDepth(from, route)
    const selected = selectBoundaries(changedDepth)
    const page: AcceptedPage = {
      route,
      changedDepth,
      readiness: createPageReadiness(),
      boundaries: selected,
      pendingBoundaries: new Set(selected),
    }
    acceptedPage = page
    pageReadiness.set(route, page.readiness)
    // Plain Vue Router outlets keep their normal post-patch scroll timing.
    // Enhanced outlets require a positive report from their rendered branch.
    void nextTick(() => finishPageIfReady(page))
  }

  const refreshPageBoundaries = () => {
    if (!acceptedPage) return
    const page = acceptedPage
    const selected = selectBoundaries(page.changedDepth)
    for (const boundary of selected) {
      if (!page.boundaries.has(boundary)) page.pendingBoundaries.add(boundary)
    }
    for (const boundary of page.boundaries) {
      if (!selected.has(boundary)) page.pendingBoundaries.delete(boundary)
    }
    page.boundaries = selected
    // Registration changes during a patch must not transiently report ready.
    void nextTick(() => finishPageIfReady(page))
  }

  const pageRendered = (
    route: RouteLocationNormalizedLoaded,
    boundary: SsrNavigationBoundarySubscriber
  ) => {
    const page = acceptedPage
    if (
      !page ||
      page.route !== route ||
      options.router.currentRoute.value !== route ||
      !page.pendingBoundaries.delete(boundary)
    ) {
      return
    }
    finishPageIfReady(page)
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
      } else if (acceptedPage?.route === current.transaction.to) {
        pageRendered(acceptedPage.route, boundary)
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
    active = {
      transaction,
      origin: transaction.to,
      boundaries: nextBoundaries,
      pendingBoundaries: new Set(),
      routerAccepted: false,
      terminalOutcome: 'success',
    }

    if (previous) {
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
          } else if (acceptedPage?.route === current.transaction.to) {
            pageRendered(acceptedPage.route, boundary)
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
        // No loading transaction is needed without mounted loading UI. Page
        // readiness is still tracked on acceptance, including initial mount.
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
        return true
      })

  const removeAfter = options.server
    ? () => undefined
    : options.router.afterEach((to, from, failure) => {
        if (disposed) return
        if (initialNavigationPending && from === START_LOCATION) {
          initialNavigationPending = false
        }
        if (!failure && options.router.currentRoute.value === to) {
          acceptPage(options.router.currentRoute.value, from)
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

  // A consumer router factory may have completed routing before installation.
  // It still needs the same initial rendered-page checkpoint.
  if (!options.server && options.router.currentRoute.value !== START_LOCATION) {
    acceptPage(options.router.currentRoute.value, START_LOCATION)
  }

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
      refreshPageBoundaries()
      refreshActiveBoundaries()
      return () => {
        const registered = boundaries.get(subscriber.depth)
        if (!registered?.delete(subscriber)) return
        boundaryCount -= 1
        if (!registered.size) boundaries.delete(subscriber.depth)
        refreshPageBoundaries()
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
      if (acceptedPage) {
        pageRendered(acceptedPage.route, boundary)
      }
      if (!active.pendingBoundaries.size) {
        settle(transactionId, active.terminalOutcome)
      }
    },
    pageRendered,
    appMounted() {
      if (disposed) return
      mounted = true
      const page = acceptedPage
      if (page) void nextTick(() => finishPageIfReady(page))
    },
    async whenPageReady(route) {
      const readiness = pageReadiness.get(route)
      if (disposed || !readiness) return false
      return (
        (await readiness.promise) &&
        !disposed &&
        acceptedPage?.route === route &&
        options.router.currentRoute.value === route
      )
    },
    isPageCurrent(route) {
      return (
        !disposed &&
        acceptedPage?.route === route &&
        options.router.currentRoute.value === route
      )
    },
    dispose() {
      if (disposed) return
      disposed = true
      removeBefore()
      removeAfter()
      removeError()
      if (active) settle(active.transaction.id, 'dispose')
      acceptedPage?.readiness.resolve(false)
      acceptedPage = undefined
      subscribers.clear()
      boundaries.clear()
      boundaryCount = 0
      initialNavigationPending = false
    },
  }
}
