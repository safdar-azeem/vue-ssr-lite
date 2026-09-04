import {
  Comment,
  Fragment,
  KeepAlive,
  Suspense,
  computed,
  defineComponent,
  h,
  inject,
  isVNode,
  nextTick,
  onBeforeUnmount,
  provide,
  shallowReactive,
  shallowRef,
  unref,
  watch,
  type PropType,
  type ShallowRef,
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

const NAVIGATION_GATE_NAME = 'RouterViewNavigationGate'
const ROUTE_BRANCH_NAME = 'RouterViewRouteBranch'

const asSingleVNode = (content: VNodeChild | VNodeChild[]): VNode => {
  const children = Array.isArray(content) ? content : [content]
  if (children.length === 0) return h(Comment)
  if (children.length === 1 && isVNode(children[0])) return children[0]
  return h(Fragment, null, children)
}

const NavigationGate = defineComponent({
  name: NAVIGATION_GATE_NAME,
  props: {
    pending: {
      type: Promise as PropType<Promise<void>>,
      required: true,
    },
  },
  async setup(props) {
    await props.pending
    return () => null
  },
})

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
  readonly routeRef: ShallowRef<RouteLocationNormalizedLoaded>
  readonly routeView: ShallowRef<ReturnType<typeof routeViewAtDepth>>
  source: RouteLocationNormalizedLoaded
  depth: number
}

const createRouteOwnership = (
  key: symbol,
  route: RouteLocationNormalizedLoaded,
  depth: number
): RouteOwnership => {
  const ownedRoute = shallowReactive({
    ...route,
  }) as RouteLocationNormalizedLoaded
  return {
    key,
    route: ownedRoute,
    routeRef: shallowRef(ownedRoute),
    routeView: shallowRef(routeViewAtDepth(route, depth)),
    source: route,
    depth,
  }
}

const updateRouteOwnership = (
  ownership: RouteOwnership,
  route: RouteLocationNormalizedLoaded,
  depth: number
) => {
  if (ownership.source === route && ownership.depth === depth) return
  ownership.source = route
  ownership.depth = depth
  Object.assign(ownership.route, route)
  ownership.routeView.value = routeViewAtDepth(route, depth)
}

// Suspense sees one stable pending root while navigation work hands off to the
// routed component. This boundary is fragment-transparent in the DOM.
const RouteBranch = defineComponent({
  name: ROUTE_BRANCH_NAME,
  props: {
    ownership: {
      type: Object as PropType<RouteOwnership>,
      required: true,
    },
  },
  setup(props, { slots }) {
    // Capture the ownership object once. Parent patches cannot retarget a
    // retained component to another branch's route context.
    const ownership = props.ownership
    provide(routeLocationKey, ownership.route)
    provide(routerViewLocationKey, ownership.routeRef)
    provide(
      matchedRouteKey,
      computed(() => ownership.routeView.value.matchedRoute)
    )
    provide(
      viewDepthKey,
      computed(() => ownership.routeView.value.depth + 1)
    )

    return () => asSingleVNode(slots.default?.() ?? h(Comment))
  },
})

interface RouteIdentity {
  readonly type: VNode['type']
  readonly key: VNode['key']
}

interface LoadingCycle {
  id: number
  readonly startedAt: number
  readonly branchKey: symbol
  readonly pending: Promise<void>
  readonly resolve: () => void
  readonly ownership: RouteOwnership
  navigationPending: boolean
}

const createGate = () => {
  let resolve!: () => void
  const pending = new Promise<void>((accept) => {
    resolve = accept
  })
  return { pending, resolve }
}

const createLoadingCycle = (
  transaction: SsrNavigationTransaction,
  depth: number,
  startedAt = transaction.startedAt
): LoadingCycle => {
  const gate = createGate()
  const branchKey = Symbol('route loading branch')
  return {
    id: transaction.id,
    startedAt,
    branchKey,
    pending: gate.pending,
    resolve: gate.resolve,
    ownership: createRouteOwnership(
      branchKey,
      transaction.to as RouteLocationNormalizedLoaded,
      depth
    ),
    navigationPending: true,
  }
}

const sameRouteIdentity = (
  left: RouteIdentity | undefined,
  right: RouteIdentity
) => left?.type === right.type && left.key === right.key

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
    const retainRoutes = shallowRef(true)
    let unregister: () => void = () => undefined
    let activeIdentity: RouteIdentity | undefined
    let activeBranchKey = Symbol('accepted route branch')
    let activeOwnership: RouteOwnership | undefined
    let candidateIdentity: RouteIdentity | undefined
    let candidateBranchKey = Symbol('candidate route branch')
    let candidateOwnership: RouteOwnership | undefined
    let renderedIdentity: RouteIdentity | undefined
    let renderedBranchKey = activeBranchKey
    let renderedOwnership: RouteOwnership | undefined
    let suspensePending = false
    let pendingStartedAt = 0
    let needsPrune = false
    let pruneVersion = 0
    let unmounted = false

    const pruneInactiveRoutes = () => {
      const version = ++pruneVersion
      retainRoutes.value = false
      void nextTick(() => {
        if (!unmounted && version === pruneVersion) retainRoutes.value = true
      })
    }

    const finish = (cycle: LoadingCycle) => {
      if (loading.value?.branchKey !== cycle.branchKey) return
      loading.value = undefined
      cycle.resolve()
      needsPrune = false
      pruneInactiveRoutes()
    }

    const start = (transaction: SsrNavigationTransaction) => {
      needsPrune = true
      candidateOwnership = undefined
      const current = loading.value
      if (current?.navigationPending && suspensePending) {
        current.id = transaction.id
        updateRouteOwnership(
          current.ownership,
          transaction.to as RouteLocationNormalizedLoaded,
          unref(injectedDepth)
        )
        loading.value = { ...current }
        return
      }

      if (suspensePending) {
        loading.value = createLoadingCycle(
          transaction,
          unref(injectedDepth),
          current?.startedAt || pendingStartedAt || transaction.startedAt
        )
        return
      }

      loading.value = createLoadingCycle(transaction, unref(injectedDepth))
    }

    const settle = (transactionId: number) => {
      const cycle = loading.value
      if (!cycle || cycle.id !== transactionId) return
      cycle.navigationPending = false
      loading.value = { ...cycle }

      // Patch the gate to routed content before resolving its abandoned async
      // setup, so routed async children join the same Suspense pass.
      void nextTick(cycle.resolve)
    }

    const retarget = (transaction: SsrNavigationTransaction) => {
      const cycle = loading.value
      if (
        !cycle ||
        cycle.id !== transaction.id ||
        !cycle.navigationPending
      ) {
        return
      }
      updateRouteOwnership(
        cycle.ownership,
        transaction.to as RouteLocationNormalizedLoaded,
        unref(injectedDepth)
      )
      loading.value = { ...cycle }
    }

    const subscriberForDepth = (
      depth: number
    ): SsrNavigationBoundarySubscriber => ({
      depth,
      start,
      retarget,
      settle,
    })

    // Without a fallback there is no navigation presentation to coordinate.
    // Native Suspense still handles routed async setup below.
    if (runtime && slots.fallback) {
      watch(
        () => unref(injectedDepth),
        (depth) => {
          unregister()
          unregister = runtime.registerBoundary(subscriberForDepth(depth))
        },
        { immediate: true }
      )
    }

    onBeforeUnmount(() => {
      unmounted = true
      pruneVersion += 1
      unregister()
      loading.value?.resolve()
    })

    const onPending = () => {
      suspensePending = true
      if (!pendingStartedAt) pendingStartedAt = Date.now()
      if (activeIdentity) needsPrune = true
    }

    const onResolve = () => {
      suspensePending = false
      pendingStartedAt = 0
      if (renderedIdentity) activeIdentity = renderedIdentity
      activeBranchKey = renderedBranchKey
      if (renderedOwnership) activeOwnership = renderedOwnership
      candidateIdentity = undefined
      candidateOwnership = undefined

      const cycle = loading.value
      if (cycle && !cycle.navigationPending) {
        void nextTick(() => finish(cycle))
      } else if (!cycle && needsPrune) {
        needsPrune = false
        void nextTick(() => {
          if (!loading.value && !suspensePending) pruneInactiveRoutes()
        })
      }
    }

    const branchKeyFor = (identity: RouteIdentity) => {
      if (!activeIdentity || sameRouteIdentity(activeIdentity, identity)) {
        return activeBranchKey
      }
      if (!sameRouteIdentity(candidateIdentity, identity)) {
        candidateIdentity = identity
        candidateBranchKey = Symbol('candidate route branch')
      }
      return candidateBranchKey
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
            const routeContent = slots.default
              ? asSingleVNode(slots.default({ Component, route }))
              : Component ?? h(Comment)
            const routeView = routeViewAtDepth(route, unref(injectedDepth))
            const identity: RouteIdentity = {
              type: routeContent.type,
              key: routeContent.key,
            }
            const cycle = loading.value
            let branchKey: symbol
            let ownership: RouteOwnership
            if (!cycle) {
              branchKey = branchKeyFor(identity)
              if (branchKey === activeBranchKey) {
                activeOwnership ??= createRouteOwnership(
                  branchKey,
                  route,
                  routeView.depth
                )
                updateRouteOwnership(
                  activeOwnership,
                  route,
                  routeView.depth
                )
                ownership = activeOwnership
              } else {
                const candidate =
                  candidateOwnership?.key === branchKey
                    ? candidateOwnership
                    : createRouteOwnership(
                        branchKey,
                        route,
                        routeView.depth
                      )
                candidateOwnership = candidate
                updateRouteOwnership(
                  candidate,
                  route,
                  routeView.depth
                )
                ownership = candidate
              }
            } else if (
              !cycle.navigationPending &&
              sameRouteIdentity(activeIdentity, identity)
            ) {
              branchKey = activeBranchKey
              activeOwnership ??= createRouteOwnership(
                branchKey,
                route,
                routeView.depth
              )
              updateRouteOwnership(
                activeOwnership,
                route,
                routeView.depth
              )
              ownership = activeOwnership
            } else {
              branchKey = cycle.branchKey
              if (!cycle.navigationPending) {
                updateRouteOwnership(
                  cycle.ownership,
                  route,
                  routeView.depth
                )
              }
              ownership = cycle.ownership
            }
            const content = cycle?.navigationPending
              ? h(NavigationGate, { pending: cycle.pending })
              : routeContent
            const timeout = cycle
              ? Math.max(
                  0,
                  props.delay - (Date.now() - cycle.startedAt)
                )
              : props.delay

            renderedIdentity = identity
            renderedBranchKey = branchKey
            renderedOwnership = ownership

            const boundary = h(
              Suspense,
              {
                timeout: slots.fallback ? timeout : -1,
                onPending,
                onResolve,
              },
              {
                default: () =>
                  h(
                    RouteBranch,
                    {
                      key: ownership.key,
                      ownership,
                    },
                    () => content
                  ),
                fallback: () =>
                  asSingleVNode(slots.fallback?.() ?? h(Comment)),
              }
            )

            // KeepAlive owns at most the accepted and in-flight RouteBranch.
            // onResolve prunes the inactive one, so a fallback never creates a
            // persistent route cache or changes later navigation reuse.
            return slots.fallback
              ? h(
                  KeepAlive,
                  {
                    max: 2,
                    exclude: retainRoutes.value
                      ? undefined
                      : ROUTE_BRANCH_NAME,
                  },
                  () => boundary
                )
              : boundary
          },
        }
      )
  },
})
