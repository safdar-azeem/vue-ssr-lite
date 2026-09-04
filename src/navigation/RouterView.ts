import {
  Comment,
  Fragment,
  KeepAlive,
  Suspense,
  cloneVNode,
  computed,
  defineComponent,
  h,
  inject,
  isVNode,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  provide,
  shallowReactive,
  shallowRef,
  unref,
  watch,
  type PropType,
  type ShallowRef,
  type Slot,
  type VNode,
  type VNodeChild,
} from 'vue'
import {
  RouterView as VueRouterView,
  matchedRouteKey,
  routeLocationKey,
  routerViewLocationKey,
  viewDepthKey,
  type RouteLocationNormalizedLoaded,
} from 'vue-router'
import { SSR_NAVIGATION_RUNTIME } from './SsrNavigationRuntime'
import type {
  SsrNavigationBoundarySubscriber,
  SsrNavigationTransaction,
} from './SsrNavigationTypes'

const PAGE_PRESENTER_NAME = 'RouterViewPagePresenter'

// Nested outlets receive the provider's route snapshot, not currentRoute's
// object. Preserve the canonical generation without matching by URL (which
// could mistake a late render from an earlier visit for the current visit).
const routeSources = new WeakMap<object, RouteLocationNormalizedLoaded>()
const sourceRouteFor = (route: RouteLocationNormalizedLoaded) =>
  routeSources.get(route) ?? route

const asSingleVNode = (content: VNodeChild | VNodeChild[]): VNode => {
  const children = Array.isArray(content) ? content : [content]
  if (children.length === 0) return h(Comment)
  if (children.length === 1 && isVNode(children[0])) return children[0]
  return h(Fragment, null, children)
}

const routeViewAtDepth = (
  route: RouteLocationNormalizedLoaded,
  initialDepth: number
) => {
  let depth = initialDepth
  let matchedRoute = route.matched[depth]
  while (matchedRoute && !matchedRoute.components) {
    matchedRoute = route.matched[++depth]
  }
  return { depth, matchedRoute }
}

interface RouteOwnership {
  readonly key: symbol
  readonly route: RouteLocationNormalizedLoaded
  readonly routeView: ShallowRef<ReturnType<typeof routeViewAtDepth>>
  source: RouteLocationNormalizedLoaded
  depth: number
}

const createRouteOwnership = (
  route: RouteLocationNormalizedLoaded,
  depth: number
): RouteOwnership => {
  const ownedRoute = shallowReactive({
    ...route,
  }) as RouteLocationNormalizedLoaded
  const source = sourceRouteFor(route)
  routeSources.set(ownedRoute, source)
  return {
    key: Symbol('route page generation'),
    route: ownedRoute,
    routeView: shallowRef(routeViewAtDepth(route, depth)),
    source,
    depth,
  }
}

const updateRouteOwnership = (
  ownership: RouteOwnership,
  route: RouteLocationNormalizedLoaded,
  depth: number
) => {
  const source = sourceRouteFor(route)
  if (ownership.source === source && ownership.depth === depth) return
  ownership.source = source
  routeSources.set(ownership.route, source)
  ownership.depth = depth
  Object.assign(ownership.route, route)
  ownership.routeView.value = routeViewAtDepth(route, depth)
}

/**
 * A stable provider prevents a retired async page from observing a newer
 * route. Reused, already-resolved pages intentionally retain the same
 * ownership object so Vue Router's normal update semantics remain intact.
 */
const RouteProvider = defineComponent({
  name: 'RouterViewRouteProvider',
  props: {
    ownership: {
      type: Object as PropType<RouteOwnership>,
      required: true,
    },
    component: Object as PropType<VNode>,
    ready: Function as PropType<() => void>,
  },
  setup(props) {
    const route = {} as RouteLocationNormalizedLoaded
    for (const key in props.ownership.route) {
      Object.defineProperty(route, key, {
        enumerable: true,
        get: () =>
          props.ownership.route[key as keyof RouteLocationNormalizedLoaded],
      })
    }
    provide(routeLocationKey, shallowReactive(route))
    provide(
      routerViewLocationKey,
      computed(() => props.ownership.route)
    )
    provide(
      matchedRouteKey,
      computed(() => props.ownership.routeView.value.matchedRoute)
    )
    provide(
      viewDepthKey,
      computed(() => props.ownership.routeView.value.depth + 1)
    )
    // Mounted/updated hooks inside a pending Suspense branch are deferred until
    // that branch is actually committed. This is the positive readiness signal
    // for new pages and for safely reused, already-resolved pages alike.
    onMounted(() => props.ready?.())
    onUpdated(() => props.ready?.())
    return () => (props.component ? cloneVNode(props.component) : h(Comment))
  },
})

interface RouteIdentity {
  readonly type: VNode['type']
  readonly key: VNode['key']
}

const sameRouteIdentity = (
  left: RouteIdentity | undefined,
  right: RouteIdentity
) => left?.type === right.type && left.key === right.key

interface PageSnapshot {
  readonly component: VNode | undefined
  readonly route: RouteLocationNormalizedLoaded
  readonly ownership: RouteOwnership
  readonly pageKey: symbol
  readonly transactionId: number | undefined
  readonly timeout: number
  readonly routeSlot: Slot | undefined
  readonly fallbackSlot: Slot | undefined
  readonly pending: () => void
  readonly resolved: () => void
  readonly ready: () => void
}

/**
 * This component and its Suspense type remain stable across navigations.
 * Route generation lives in RouteProvider's key, allowing Vue to invalidate a
 * stale pending branch without tearing down a never-resolved boundary.
 */
const PagePresenter = defineComponent({
  name: PAGE_PRESENTER_NAME,
  props: {
    snapshot: {
      type: Object as PropType<PageSnapshot>,
      required: true,
    },
  },
  setup(props) {
    let pending = false
    let hasResolvedOnce = false
    let suspenseKey = 0
    let previousPageKey: symbol | undefined
    return () => {
      const snapshot = props.snapshot
      if (
        pending &&
        hasResolvedOnce &&
        previousPageKey !== undefined &&
        previousPageKey !== snapshot.pageKey
      ) {
        // Once a boundary has resolved it is safe to replace that boundary
        // generation during rapid navigation. Before its first resolution we
        // keep the exact boundary alive so a suspensible parent cannot be
        // stranded by an unresolved child disappearing beneath it.
        suspenseKey += 1
        pending = false
      }
      previousPageKey = snapshot.pageKey
      const page = h(
        Suspense,
        {
          key: suspenseKey,
          timeout: snapshot.timeout,
          suspensible: true,
          onPending: () => {
            if (props.snapshot.ownership !== snapshot.ownership) return
            pending = true
            snapshot.pending()
          },
          onResolve: () => {
            if (props.snapshot.ownership !== snapshot.ownership) return
            pending = false
            hasResolvedOnce = true
            snapshot.resolved()
          },
        },
        {
          default: () =>
            h(RouteProvider, {
              key: snapshot.pageKey,
              ownership: snapshot.ownership,
              component: snapshot.component,
              ready: snapshot.ready,
            }),
          fallback: () =>
            asSingleVNode(snapshot.fallbackSlot?.() ?? h(Comment)),
        }
      )

      // Give application-owned KeepAlive and transition wrappers the enhanced
      // page boundary as their Component. The framework does not cache those
      // pages; any long-lived cache is therefore explicitly application-owned.
      const content = snapshot.routeSlot
        ? snapshot.routeSlot({ Component: page, route: snapshot.route })
        : page

      return asSingleVNode(content)
    }
  },
})

const RouterPendingFallback = defineComponent({
  name: 'RouterViewRouterPendingFallback',
  setup(_props, { slots }) {
    return () => asSingleVNode(slots.default?.() ?? h(Comment))
  },
})

interface LoadingCycle {
  readonly id: number
  readonly startedAt: number
  phase: 'routerPending' | 'pagePending'
  showRouterFallback: boolean
}

interface OwnershipCandidate {
  readonly identity: RouteIdentity
  readonly ownership: RouteOwnership
  readonly pageKey: symbol
  readonly transactionId: number | undefined
}

export const RouterView = defineComponent({
  name: 'RouterView',
  inheritAttrs: false,
  props: {
    name: {
      type: String,
      default: 'default',
    },
    route: Object as PropType<RouteLocationNormalizedLoaded>,
    delay: {
      type: Number as PropType<number>,
      default: 120,
      validator: (value: number) => Number.isFinite(value) && value >= 0,
    },
  },
  setup(props, { attrs, slots }) {
    const runtime = inject(SSR_NAVIGATION_RUNTIME, null)
    const injectedDepth = inject(viewDepthKey, 0)
    const loading = shallowRef<LoadingCycle>()
    const retainAcceptedPresenter = shallowRef(false)
    let unregister: () => void = () => undefined
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined
    let boundaryDepth = unref(injectedDepth)
    let activeIdentity: RouteIdentity | undefined
    let activeOwnership: RouteOwnership | undefined
    let activePageKey: symbol | undefined
    let candidate: OwnershipCandidate | undefined
    let latestOwnership: RouteOwnership | undefined
    let latestPageKey: symbol | undefined
    const pageKeys = new Map<
      VNode['type'],
      Map<VNode['key'], symbol>
    >()
    let suspensePending = false
    let unmounted = false

    const clearFallbackTimer = () => {
      if (fallbackTimer === undefined) return
      clearTimeout(fallbackTimer)
      fallbackTimer = undefined
    }

    const releaseRetentionAfterPatch = (transactionId?: number) => {
      void nextTick(() => {
        if (
          unmounted ||
          loading.value?.showRouterFallback ||
          (transactionId !== undefined && loading.value?.id !== transactionId)
        ) {
          return
        }
        retainAcceptedPresenter.value = false
      })
    }

    const showRouterFallback = (cycle: LoadingCycle) => {
      if (
        unmounted ||
        suspensePending ||
        loading.value !== cycle ||
        cycle.phase !== 'routerPending'
      ) {
        return
      }
      loading.value = { ...cycle, showRouterFallback: true }
    }

    const scheduleRouterFallback = (cycle: LoadingCycle) => {
      if (!slots.fallback || suspensePending || cycle.showRouterFallback) return
      clearFallbackTimer()
      retainAcceptedPresenter.value = true

      // KeepAlive can only retain the already-mounted, fully-resolved
      // presenter after one patch has marked it as retainable. The next patch
      // deactivates that presenter and displays the router-phase fallback.
      void nextTick(() => {
        if (
          unmounted ||
          loading.value !== cycle ||
          cycle.phase !== 'routerPending' ||
          suspensePending
        ) {
          return
        }
        const remaining = Math.max(
          0,
          props.delay - (Date.now() - cycle.startedAt)
        )
        if (remaining === 0) {
          showRouterFallback(cycle)
          return
        }
        fallbackTimer = setTimeout(() => {
          fallbackTimer = undefined
          showRouterFallback(cycle)
        }, remaining)
      })
    }

    const start = (transaction: SsrNavigationTransaction) => {
      clearFallbackTimer()
      // Keep the current unresolved page branch intact while the next router
      // decision runs. It remains the router's current route until that next
      // navigation is accepted, cancelled, or redirected.
      if (!suspensePending) candidate = undefined
      const previous = loading.value
      const cycle: LoadingCycle = {
        id: transaction.id,
        startedAt: previous?.startedAt ?? transaction.startedAt,
        phase: 'routerPending',
        showRouterFallback: previous?.showRouterFallback ?? false,
      }
      loading.value = cycle

      if (cycle.showRouterFallback) {
        retainAcceptedPresenter.value = true
      } else if (!suspensePending) {
        scheduleRouterFallback(cycle)
      }
    }

    const accept = (transaction: SsrNavigationTransaction) => {
      const cycle = loading.value
      if (!cycle || cycle.id !== transaction.id) return false
      clearFallbackTimer()
      candidate = undefined
      loading.value = {
        ...cycle,
        phase: 'pagePending',
        showRouterFallback: false,
      }
      releaseRetentionAfterPatch(transaction.id)
      return true
    }

    const abort = (transactionId: number) => {
      const cycle = loading.value
      if (!cycle || cycle.id !== transactionId) return false
      clearFallbackTimer()

      if (suspensePending) {
        // The rejected target was never rendered, but the router's already-
        // current page may still be resolving from an earlier commit. Transfer
        // only the loading clock; route/page ownership remains unchanged.
        if (candidate) candidate = { ...candidate, transactionId }
        loading.value = {
          ...cycle,
          phase: 'pagePending',
          showRouterFallback: false,
        }
        releaseRetentionAfterPatch(transactionId)
        return true
      }

      candidate = undefined
      loading.value = undefined
      releaseRetentionAfterPatch()
      return false
    }

    const settle = (transactionId: number) => {
      if (loading.value?.id !== transactionId) return
      clearFallbackTimer()
      loading.value = undefined
      releaseRetentionAfterPatch()
    }

    const subscriber: SsrNavigationBoundarySubscriber = {
      get depth() {
        return boundaryDepth
      },
      start,
      retarget: () => undefined,
      accept,
      abort,
      settle,
    }

    if (runtime) {
      watch(
        () => unref(injectedDepth),
        (depth) => {
          unregister()
          boundaryDepth = depth
          unregister = runtime.registerBoundary(subscriber)
        },
        { immediate: true }
      )
    }

    onBeforeUnmount(() => {
      unmounted = true
      clearFallbackTimer()
      unregister()
    })

    const stablePageKeyFor = (identity: RouteIdentity) => {
      let keys = pageKeys.get(identity.type)
      if (!keys) {
        keys = new Map()
        pageKeys.set(identity.type, keys)
      }
      let key = keys.get(identity.key)
      if (!key) {
        key = Symbol('route page identity')
        keys.set(identity.key, key)
      }
      return key
    }

    const ownershipFor = (
      identity: RouteIdentity,
      route: RouteLocationNormalizedLoaded,
      depth: number,
      transactionId: number | undefined
    ) => {
      if (
        !suspensePending &&
        activeOwnership &&
        sameRouteIdentity(activeIdentity, identity)
      ) {
        updateRouteOwnership(activeOwnership, route, depth)
        return {
          identity,
          ownership: activeOwnership,
          pageKey: activePageKey ?? stablePageKeyFor(identity),
          transactionId,
        }
      }
      if (
        candidate &&
        (candidate.transactionId === transactionId ||
          (suspensePending && transactionId === undefined)) &&
        sameRouteIdentity(candidate.identity, identity)
      ) {
        // Vue Router can expose another normalized wrapper for subsequent
        // renders of the same accepted transaction. Updating within that one
        // transaction is safe; a new navigation clears the candidate first.
        updateRouteOwnership(candidate.ownership, route, depth)
        return candidate
      }
      const ownership = createRouteOwnership(route, depth)
      const stablePageKey = stablePageKeyFor(identity)
      const pageKey =
        suspensePending && latestPageKey === stablePageKey
          ? Symbol('route page fork')
          : stablePageKey
      candidate = { identity, ownership, pageKey, transactionId }
      return candidate
    }

    return () =>
      h(
        VueRouterView,
        {
          ...attrs,
          name: props.name,
          route: props.route,
        },
        {
          default: ({
            Component,
            route,
          }: {
            Component: VNode | undefined
            route: RouteLocationNormalizedLoaded
          }) => {
            const routeView = routeViewAtDepth(route, unref(injectedDepth))
            const identity: RouteIdentity = {
              type: Component?.type ?? Comment,
              key: Component?.key ?? null,
            }
            const cycle = loading.value
            const transactionId =
              cycle?.phase === 'pagePending' ? cycle.id : undefined
            const selected = ownershipFor(
              identity,
              route,
              routeView.depth,
              transactionId
            )
            const { ownership, pageKey } = selected
            const sourceRoute = sourceRouteFor(route)
            latestOwnership = ownership
            latestPageKey = pageKey
            const timeout = cycle
              ? Math.max(
                  0,
                  props.delay - (Date.now() - cycle.startedAt)
                )
              : props.delay
            const snapshot: PageSnapshot = {
              component: Component,
              route,
              ownership,
              pageKey,
              transactionId,
              timeout: slots.fallback ? timeout : -1,
              routeSlot: slots.default,
              fallbackSlot: slots.fallback,
              pending: () => {
                if (latestOwnership !== ownership) return
                suspensePending = true
              },
              resolved: () => {
                if (latestOwnership !== ownership) return
                suspensePending = false
                activeIdentity = identity
                activeOwnership = ownership
                activePageKey = pageKey
                candidate = undefined

                const current = loading.value
                if (current?.phase === 'routerPending') {
                  scheduleRouterFallback(current)
                }
              },
              ready: () => {
                if (unmounted || latestOwnership !== ownership) return
                // The accepted page can resolve during a different router
                // attempt, or during bootstrap with no loading transaction.
                runtime?.pageRendered(sourceRoute, subscriber)
                if (
                  transactionId === undefined ||
                  loading.value?.id !== transactionId ||
                  loading.value.phase !== 'pagePending'
                ) {
                  return
                }
                runtime?.pageReady(transactionId, subscriber)
              },
            }
            const presenter = h(PagePresenter, { snapshot })

            if (!runtime || !slots.fallback) return presenter
            return h(
              KeepAlive,
              {
                max: 1,
                include: retainAcceptedPresenter.value
                  ? [PAGE_PRESENTER_NAME]
                  : [],
              },
              {
                default: () =>
                  cycle?.showRouterFallback
                    ? h(RouterPendingFallback, null, {
                        default: slots.fallback,
                      })
                    : presenter,
              }
            )
          },
        }
      )
  },
})
