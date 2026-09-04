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
  type Component,
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
  async setup(props, { slots }) {
    await props.pending
    // The gate remains the pending branch root until it resolves. Mounting the
    // routed slot from its render effect lets async setup descendants register
    // before Vue decrements the gate's own Suspense dependency.
    return () => asSingleVNode(slots.default?.() ?? h(Comment))
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
  readonly gate: Promise<void> | undefined
  readonly name: string
  readonly component: Component
  readonly route: RouteLocationNormalizedLoaded
  readonly routeRef: ShallowRef<RouteLocationNormalizedLoaded>
  readonly routeView: ShallowRef<ReturnType<typeof routeViewAtDepth>>
  source: RouteLocationNormalizedLoaded
  depth: number
}

let routeBranchSequence = 0

const createRouteBranch = (name: string): Component =>
  defineComponent({
    name,
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

const createRouteOwnership = (
  key: symbol,
  route: RouteLocationNormalizedLoaded,
  depth: number,
  gate?: Promise<void>
): RouteOwnership => {
  const ownedRoute = shallowReactive({
    ...route,
  }) as RouteLocationNormalizedLoaded
  const name = `${ROUTE_BRANCH_NAME}${++routeBranchSequence}`
  return {
    key,
    gate,
    name,
    component: createRouteBranch(name),
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

interface RouteIdentity {
  readonly type: VNode['type']
  readonly key: VNode['key']
}

interface LoadingCycle {
  readonly id: number
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
      depth,
      gate.pending
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
    const retainedRouteBranch = shallowRef('')
    let unregister: () => void = () => undefined
    let activeIdentity: RouteIdentity | undefined
    let activeBranchKey = Symbol('accepted route branch')
    let activeOwnership: RouteOwnership | undefined
    let candidateIdentity: RouteIdentity | undefined
    let candidateBranchKey = Symbol('candidate route branch')
    let candidateOwnership: RouteOwnership | undefined
    let suspensePending = false
    let pendingStartedAt = 0
    let renderVersion = 0
    let pendingRenderVersion = 0
    let resolvedRenderVersion = 0
    let unmounted = false
    const retiredCycles = new Set<LoadingCycle>()

    const releaseAfterPatch = (cycle: LoadingCycle) => {
      retiredCycles.add(cycle)
      void nextTick(() => {
        retiredCycles.delete(cycle)
        cycle.resolve()
      })
    }

    const finish = (cycle: LoadingCycle, version: number) => {
      const current = loading.value
      if (
        unmounted ||
        resolvedRenderVersion !== version ||
        current?.id !== cycle.id ||
        current.branchKey !== cycle.branchKey ||
        current.navigationPending
      ) {
        return
      }
      loading.value = undefined
      cycle.resolve()
    }

    const start = (transaction: SsrNavigationTransaction) => {
      candidateIdentity = undefined
      candidateOwnership = undefined
      const previous = loading.value
      let startedAt = transaction.startedAt
      if (previous) {
        startedAt = previous.startedAt
      } else if (suspensePending && pendingStartedAt) {
        startedAt = pendingStartedAt
      }

      // A Suspense branch is never retargeted to another navigation. Replacing
      // the root key lets Vue invalidate the old pendingId and safely unmount
      // that generation before its framework-owned gate is released.
      loading.value = createLoadingCycle(
        transaction,
        unref(injectedDepth),
        startedAt
      )
      if (previous) releaseAfterPatch(previous)
    }

    const settle = (transactionId: number) => {
      const cycle = loading.value
      if (!cycle || cycle.id !== transactionId) return
      cycle.navigationPending = false
      loading.value = { ...cycle }

      // First patch the accepted route into the still-mounted gate's slot.
      // Resolving the gate then mounts that slot from the gate's own render
      // effect, so routed async setup joins this exact Suspense generation.
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
      unregister()
      loading.value?.resolve()
      for (const cycle of retiredCycles) cycle.resolve()
      retiredCycles.clear()
    })

    interface RenderSnapshot {
      readonly version: number
      readonly identity: RouteIdentity
      readonly branchKey: symbol
      readonly ownership: RouteOwnership
      readonly loadingId: number | undefined
    }

    const onPending = (snapshot: RenderSnapshot) => {
      if (unmounted || snapshot.version < pendingRenderVersion) return
      suspensePending = true
      pendingRenderVersion = snapshot.version
      if (!pendingStartedAt) pendingStartedAt = Date.now()
    }

    const onResolve = (snapshot: RenderSnapshot) => {
      // Suspense callbacks use the render generation that created their
      // branch. An older resolution may finish its own Vue work, but it must
      // not promote or settle the branch rendered by a newer navigation.
      if (unmounted || snapshot.version < pendingRenderVersion) return
      suspensePending = false
      pendingStartedAt = 0
      pendingRenderVersion = snapshot.version
      resolvedRenderVersion = snapshot.version
      activeIdentity = snapshot.identity
      activeBranchKey = snapshot.branchKey
      activeOwnership = snapshot.ownership
      // Only the branch which has fully resolved may be retained. Pending
      // generations never receive KeepAlive flags, so superseding one performs
      // a real unmount and Vue's stale pendingId guard remains authoritative.
      retainedRouteBranch.value = snapshot.ownership.name
      candidateIdentity = undefined
      candidateOwnership = undefined

      const cycle = loading.value
      if (
        cycle &&
        !cycle.navigationPending &&
        cycle.id === snapshot.loadingId
      ) {
        void nextTick(() => finish(cycle, snapshot.version))
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
            const content = ownership.gate
              ? h(
                  NavigationGate,
                  { pending: ownership.gate },
                  { default: () => routeContent }
                )
              : routeContent
            const timeout = cycle
              ? Math.max(
                  0,
                  props.delay - (Date.now() - cycle.startedAt)
                )
              : props.delay

            const snapshot: RenderSnapshot = {
              version: ++renderVersion,
              identity,
              branchKey,
              ownership,
              loadingId: cycle?.id,
            }
            if (suspensePending) pendingRenderVersion = snapshot.version

            const boundary = h(
              Suspense,
              {
                timeout: slots.fallback ? timeout : -1,
                onPending: () => onPending(snapshot),
                onResolve: () => onResolve(snapshot),
              },
              {
                default: () =>
                  h(
                    ownership.component,
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

            // Retain only the last resolved branch while this Suspense may
            // replace it with a fallback. Updating include after resolution
            // releases the inactive branch without ever caching unresolved
            // async setup or a navigation gate.
            return slots.fallback
              ? h(
                  KeepAlive,
                  {
                    max: 2,
                    include: retainedRouteBranch.value,
                  },
                  () => boundary
                )
              : boundary
          },
        }
      )
  },
})
