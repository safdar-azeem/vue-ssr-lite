import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import {
  createMemoryHistory,
  createRouter,
  type RouteLocationNormalized,
  type RouteLocationNormalizedLoaded,
  type Router,
} from 'vue-router'
import { createSsrNavigationRuntime } from './SsrNavigationRuntime'
import type {
  SsrNavigationBoundarySubscriber,
  SsrNavigationSubscriber,
} from './SsrNavigationTypes'

const Page = { render: () => null }

const createHarness = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Page },
      { path: '/about', component: Page },
      { path: '/login', component: Page },
      { path: '/private', component: Page },
      { path: '/slow', component: Page },
      { path: '/other', component: Page },
      {
        path: '/dashboard',
        component: Page,
        children: [
          { path: 'users', component: Page },
          { path: 'settings', component: Page },
        ],
      },
    ],
  })
  const runtime = createSsrNavigationRuntime({ router, server: false })
  await router.push('/')
  return { router, runtime }
}

const listener = () => {
  const starts: number[] = []
  const settles: number[] = []
  const subscriber: SsrNavigationSubscriber = {
    start: ({ id }) => starts.push(id),
    settle: (id) => settles.push(id),
  }
  return { starts, settles, subscriber }
}

const boundary = (depth: number) => {
  const starts: number[] = []
  const accepts: number[] = []
  const settles: number[] = []
  const subscriber: SsrNavigationBoundarySubscriber = {
    depth,
    start: ({ id }) => starts.push(id),
    accept: ({ id }) => {
      accepts.push(id)
      return false
    },
    abort: () => false,
    settle: (id) => settles.push(id),
  }
  return { starts, accepts, settles, subscriber }
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe('SsrNavigationRuntime', () => {
  it('observes start and settle while ignoring the initial router navigation', async () => {
    const { router, runtime } = await createHarness()
    const events = listener()
    runtime.subscribe(events.subscriber)

    await router.push('/about')

    expect(events.starts).toEqual([1])
    expect(events.settles).toEqual([1])
    runtime.dispose()
  })

  it('observes a later user navigation when the initial SPA target was cancelled', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: Page },
        { path: '/about', component: Page },
      ],
    })
    const runtime = createSsrNavigationRuntime({ router, server: false })
    let cancelInitial = true
    router.beforeEach(() => {
      if (cancelInitial) return false
    })
    await router.push('/')
    cancelInitial = false
    const events = listener()
    runtime.subscribe(events.subscriber)

    await router.push('/about')

    expect(events.starts).toEqual([1])
    expect(events.settles).toEqual([1])
    runtime.dispose()
  })

  it('settles cancellation and guard errors', async () => {
    const { router, runtime } = await createHarness()
    const events = listener()
    runtime.subscribe(events.subscriber)
    router.beforeEach((to) => {
      if (to.path === '/slow') return false
      if (to.path === '/other') throw new Error('guard failed')
    })

    await router.push('/slow')
    await expect(router.push('/other')).rejects.toThrow('guard failed')

    expect(events.starts).toEqual([1, 2])
    expect(events.settles).toEqual([1, 2])
    runtime.dispose()
  })

  it('settles a selected boundary immediately when navigation is cancelled', async () => {
    const { router, runtime } = await createHarness()
    const routeBoundary = boundary(0)
    runtime.registerBoundary(routeBoundary.subscriber)
    router.beforeEach((to) => {
      if (to.path === '/slow') return false
    })

    await router.push('/slow')

    expect(routeBoundary.starts).toEqual([1])
    expect(routeBoundary.settles).toEqual([1])
    runtime.dispose()
  })

  it('keeps a redirect chain in one visual transaction', async () => {
    const { router, runtime } = await createHarness()
    const events = listener()
    runtime.subscribe(events.subscriber)
    router.beforeEach((to) => {
      if (to.path === '/private') return '/login'
      if (to.path === '/login') return '/about'
      return true
    })

    await router.push('/private')

    expect(router.currentRoute.value.path).toBe('/about')
    expect(events.starts).toEqual([1])
    expect(events.settles).toEqual([1])
    runtime.dispose()
  })

  it('settles a redirect back to the already-current route exactly once', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/login', component: Page },
        { path: '/dashboard', component: Page },
      ],
    })
    const runtime = createSsrNavigationRuntime({ router, server: false })
    await router.push('/login?redirect=/dashboard')
    const events = listener()
    runtime.subscribe(events.subscriber)
    router.beforeEach((to) => {
      if (to.path === '/dashboard') {
        return {
          path: '/login',
          query: { redirect: '/dashboard' },
        }
      }
    })

    await router.push('/dashboard')

    expect(router.currentRoute.value.fullPath).toBe(
      '/login?redirect=/dashboard'
    )
    expect(events.starts).toEqual([1])
    expect(events.settles).toEqual([1])
    await nextTick()
    expect(events.settles).toEqual([1])
    const late = listener()
    runtime.subscribe(late.subscriber)
    expect(late.starts).toEqual([])
    runtime.dispose()
  })

  it('ignores stale settlement after a navigation is superseded', async () => {
    const { router, runtime } = await createHarness()
    const events = listener()
    const slow = deferred()
    const other = deferred()
    const slowEntered = deferred()
    const otherEntered = deferred()
    runtime.subscribe(events.subscriber)
    router.beforeEach((to) => {
      if (to.path === '/slow') {
        slowEntered.resolve()
        return slow.promise
      }
      if (to.path === '/other') {
        otherEntered.resolve()
        return other.promise
      }
    })

    const first = router.push('/slow')
    await slowEntered.promise
    const second = router.push('/other')
    await otherEntered.promise

    expect(events.starts).toEqual([1, 2])
    expect(events.settles).toEqual([1])

    slow.resolve()
    await first

    expect(events.starts).toEqual([1, 2])
    expect(events.settles).toEqual([1])

    other.resolve()
    await second
    expect(events.settles).toEqual([1, 2])
    runtime.dispose()
  })

  it('selects the inner boundary for child changes and the outer for parent changes', async () => {
    const { router, runtime } = await createHarness()
    await router.push('/dashboard/users')
    const outer = boundary(0)
    const inner = boundary(1)
    runtime.registerBoundary(outer.subscriber)
    runtime.registerBoundary(inner.subscriber)

    await router.push('/dashboard/settings')
    expect(inner.starts).toEqual([1])
    expect(outer.starts).toEqual([])
    expect(inner.settles).toEqual([1])

    await router.push('/about')
    expect(outer.starts).toEqual([2])
    expect(inner.starts).toEqual([1])
    expect(outer.settles).toEqual([2])
    runtime.dispose()
  })

  it('falls back to the closest registered ancestor boundary', async () => {
    const { router, runtime } = await createHarness()
    await router.push('/dashboard/users')
    const outer = boundary(0)
    runtime.registerBoundary(outer.subscriber)

    await router.push('/dashboard/settings')

    expect(outer.starts).toEqual([1])
    expect(outer.settles).toEqual([1])
    runtime.dispose()
  })

  it('settles successful navigation after router afterEach reaches Vue nextTick', async () => {
    const { router, runtime } = await createHarness()
    const order: string[] = []
    runtime.subscribe({
      start: () => order.push('start'),
      settle: () => order.push('settle'),
    })
    router.afterEach(() => order.push('afterEach'))

    await router.push('/about')

    expect(order).toEqual(['start', 'afterEach', 'settle'])
    runtime.dispose()
  })

  it('keeps the navigation active until the selected page boundary resolves', async () => {
    const { router, runtime } = await createHarness()
    const events = listener()
    const routeBoundary = boundary(0)
    routeBoundary.subscriber.accept = ({ id }) => {
      routeBoundary.accepts.push(id)
      return true
    }
    runtime.subscribe(events.subscriber)
    runtime.registerBoundary(routeBoundary.subscriber)

    await router.push('/about')
    await nextTick()

    expect(routeBoundary.accepts).toEqual([1])
    expect(events.settles).toEqual([])
    runtime.pageReady(1, routeBoundary.subscriber)
    expect(events.settles).toEqual([1])
    expect(routeBoundary.settles).toEqual([1])
    runtime.dispose()
  })

  it('resolves scroll ownership only after the exact destination page is ready', async () => {
    const { router, runtime } = await createHarness()
    const routeBoundary = boundary(0)
    routeBoundary.subscriber.accept = ({ id }) => {
      routeBoundary.accepts.push(id)
      return true
    }
    runtime.registerBoundary(routeBoundary.subscriber)

    await router.push('/about')
    const acceptedRoute = router.currentRoute.value
    let readinessSettled = false
    const readiness = runtime.whenPageReady(acceptedRoute).then((ready) => {
      readinessSettled = true
      return ready
    })
    await Promise.resolve()
    expect(readinessSettled).toBe(false)
    expect(runtime.isPageCurrent(acceptedRoute)).toBe(true)

    runtime.pageReady(1, routeBoundary.subscriber)
    await expect(readiness).resolves.toBe(true)
    runtime.dispose()
  })

  it('revokes page and scroll ownership when a destination is superseded', async () => {
    const { router, runtime } = await createHarness()
    const routeBoundary = boundary(0)
    routeBoundary.subscriber.accept = ({ id }) => {
      routeBoundary.accepts.push(id)
      return true
    }
    runtime.registerBoundary(routeBoundary.subscriber)

    await router.push('/slow')
    const staleRoute = router.currentRoute.value
    const staleReadiness = runtime.whenPageReady(staleRoute)
    await router.push('/about')

    await expect(staleReadiness).resolves.toBe(false)
    expect(runtime.isPageCurrent(staleRoute)).toBe(false)
    runtime.pageReady(2, routeBoundary.subscriber)
    runtime.dispose()
  })

  it('ignores stale page readiness after a newer navigation takes ownership', async () => {
    const { router, runtime } = await createHarness()
    const events = listener()
    const routeBoundary = boundary(0)
    routeBoundary.subscriber.accept = ({ id }) => {
      routeBoundary.accepts.push(id)
      return true
    }
    runtime.subscribe(events.subscriber)
    runtime.registerBoundary(routeBoundary.subscriber)

    await router.push('/slow')
    await router.push('/about')
    runtime.pageReady(1, routeBoundary.subscriber)

    expect(events.starts).toEqual([1, 2])
    expect(events.settles).toEqual([1])
    runtime.pageReady(2, routeBoundary.subscriber)
    expect(events.settles).toEqual([1, 2])
    runtime.dispose()
  })

  it('does not let cloned same-target terminal hooks settle a newer generation', async () => {
    const source = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: Page },
        { path: '/dashboard', component: Page },
      ],
    })
    const from = source.resolve('/') as RouteLocationNormalizedLoaded
    const firstDashboard = source.resolve(
      '/dashboard'
    ) as RouteLocationNormalized
    const secondDashboard = {
      ...source.resolve('/dashboard'),
    } as RouteLocationNormalized
    let before:
      | ((
          target: RouteLocationNormalized,
          previous: RouteLocationNormalizedLoaded
        ) => unknown)
      | undefined
    let after:
      | ((
          target: RouteLocationNormalized,
          previous: RouteLocationNormalizedLoaded,
          failure?: unknown
        ) => unknown)
      | undefined
    let error:
      | ((
          failure: unknown,
          target: RouteLocationNormalized,
          previous: RouteLocationNormalizedLoaded
        ) => unknown)
      | undefined
    const router = {
      currentRoute: { value: from },
      beforeEach(handler: typeof before) {
        before = handler
        return () => undefined
      },
      afterEach(handler: typeof after) {
        after = handler
        return () => undefined
      },
      onError(handler: typeof error) {
        error = handler
        return () => undefined
      },
    } as unknown as Router
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const runtime = createSsrNavigationRuntime({
      router,
      server: false,
      diagnostics: true,
    })
    const events = listener()
    runtime.subscribe(events.subscriber)

    try {
      await before!(firstDashboard, from)
      await before!(secondDashboard, from)
      expect(events.starts).toEqual([1, 2])
      expect(events.settles).toEqual([1])

      await after!({ ...firstDashboard }, from)
      await nextTick()
      expect(events.settles).toEqual([1])

      await error!(new Error('stale failure'), { ...firstDashboard }, from)
      expect(events.settles).toEqual([1])
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('ignored unmapped stale afterEach navigation'),
        { staleTo: '/dashboard', activeTo: '/dashboard' }
      )
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('ignored unmapped stale onError navigation'),
        { staleTo: '/dashboard', activeTo: '/dashboard' }
      )

      await after!(secondDashboard, from)
      await nextTick()
      expect(events.settles).toEqual([1, 2])
    } finally {
      runtime.dispose()
      warning.mockRestore()
      debug.mockRestore()
    }
  })

  it('does not let an unmapped stale terminal hook settle the current generation', async () => {
    const source = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: Page },
        { path: '/slow', component: Page },
        { path: '/about', component: Page },
      ],
    })
    const from = source.resolve('/') as RouteLocationNormalizedLoaded
    const slow = source.resolve('/slow') as RouteLocationNormalized
    const about = source.resolve('/about') as RouteLocationNormalized
    let before:
      | ((
          target: RouteLocationNormalized,
          previous: RouteLocationNormalizedLoaded
        ) => unknown)
      | undefined
    let after:
      | ((
          target: RouteLocationNormalized,
          previous: RouteLocationNormalizedLoaded,
          failure?: unknown
        ) => unknown)
      | undefined
    const router = {
      currentRoute: { value: from },
      beforeEach(handler: typeof before) {
        before = handler
        return () => undefined
      },
      afterEach(handler: typeof after) {
        after = handler
        return () => undefined
      },
      onError() {
        return () => undefined
      },
    } as unknown as Router
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const runtime = createSsrNavigationRuntime({
      router,
      server: false,
      diagnostics: true,
    })
    const events = listener()
    runtime.subscribe(events.subscriber)

    try {
      await before!(slow, from)
      await before!(about, from)
      await after!({ ...slow }, from)
      await nextTick()

      expect(events.starts).toEqual([1, 2])
      expect(events.settles).toEqual([1])
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('ignored unmapped stale afterEach navigation'),
        { staleTo: '/slow', activeTo: '/about' }
      )

      await after!(about, from)
      await nextTick()
      expect(events.settles).toEqual([1, 2])
    } finally {
      runtime.dispose()
      warning.mockRestore()
      debug.mockRestore()
    }
  })

  it('rejects cloned stale redirect ancestry with the same active origin path', async () => {
    const source = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/login', component: Page },
        { path: '/dashboard', component: Page },
      ],
    })
    const from = source.resolve('/login') as RouteLocationNormalizedLoaded
    const firstOrigin = source.resolve(
      '/dashboard'
    ) as RouteLocationNormalized
    const secondOrigin = {
      ...source.resolve('/dashboard'),
    } as RouteLocationNormalized
    const login = source.resolve('/login') as RouteLocationNormalized
    let before:
      | ((
          target: RouteLocationNormalized,
          previous: RouteLocationNormalizedLoaded
        ) => unknown)
      | undefined
    let after:
      | ((
          target: RouteLocationNormalized,
          previous: RouteLocationNormalizedLoaded,
          failure?: unknown
        ) => unknown)
      | undefined
    const router = {
      currentRoute: { value: from },
      beforeEach(handler: typeof before) {
        before = handler
        return () => undefined
      },
      afterEach(handler: typeof after) {
        after = handler
        return () => undefined
      },
      onError() {
        return () => undefined
      },
    } as unknown as Router
    const runtime = createSsrNavigationRuntime({ router, server: false })
    const events = listener()
    runtime.subscribe(events.subscriber)

    await before!(firstOrigin, from)
    await before!(secondOrigin, from)
    expect(events.starts).toEqual([1, 2])
    expect(events.settles).toEqual([1])

    const staleTerminal = {
      ...login,
      redirectedFrom: { ...firstOrigin },
    } as RouteLocationNormalized
    await after!(staleTerminal, from, {})
    await nextTick()
    expect(events.settles).toEqual([1])

    const currentTerminal = {
      ...login,
      redirectedFrom: secondOrigin,
    } as RouteLocationNormalized
    await after!(currentTerminal, from, {})
    expect(events.settles).toEqual([1, 2])
    runtime.dispose()
  })

  it('cleans up listeners and boundary registrations', async () => {
    const { router, runtime } = await createHarness()
    const events = listener()
    const routeBoundary = boundary(0)
    const unsubscribe = runtime.subscribe(events.subscriber)
    const unregister = runtime.registerBoundary(routeBoundary.subscriber)
    unsubscribe()
    unregister()

    await router.push('/about')

    expect(events.starts).toEqual([])
    expect(routeBoundary.starts).toEqual([])
    runtime.dispose()
  })

  it('terminates the active generation exactly once when disposed', async () => {
    const { router, runtime } = await createHarness()
    const events = listener()
    const slow = deferred()
    const slowEntered = deferred()
    runtime.subscribe(events.subscriber)
    router.beforeEach((to) => {
      if (to.path === '/slow') {
        slowEntered.resolve()
        return slow.promise
      }
    })

    const navigation = router.push('/slow')
    await slowEntered.promise
    expect(events.starts).toEqual([1])

    runtime.dispose()
    expect(events.settles).toEqual([1])

    slow.resolve()
    await navigation
    expect(events.settles).toEqual([1])
  })

  it('does no subscriber work when no loading UI is mounted', async () => {
    const { router, runtime } = await createHarness()
    await expect(router.push('/about')).resolves.toBeUndefined()
    runtime.dispose()
  })

  it('isolates navigation state between applications', async () => {
    const left = await createHarness()
    const right = await createHarness()
    const leftEvents = listener()
    const rightEvents = listener()
    left.runtime.subscribe(leftEvents.subscriber)
    right.runtime.subscribe(rightEvents.subscriber)

    await left.router.push('/about')

    expect(leftEvents.starts).toEqual([1])
    expect(rightEvents.starts).toEqual([])
    left.runtime.dispose()
    right.runtime.dispose()
  })
})
