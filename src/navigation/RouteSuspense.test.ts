// @vitest-environment jsdom
import { renderToString } from '@vue/server-renderer'
import {
  createApp,
  createSSRApp,
  defineComponent,
  h,
  nextTick,
  ref,
} from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { viewDepthKey } from 'vue-router'
import { RouteSuspense } from './RouteSuspense'
import { SSR_NAVIGATION_RUNTIME } from './SsrNavigationRuntime'
import type {
  SsrNavigationBoundarySubscriber,
  SsrNavigationRuntime,
  SsrNavigationTransaction,
} from './SsrNavigationTypes'

const transaction = (id = 1): SsrNavigationTransaction =>
  ({
    id,
    from: {},
    to: {},
    changedDepth: 0,
    startedAt: Date.now(),
  }) as unknown as SsrNavigationTransaction

const runtimeHarness = () => {
  let boundary: SsrNavigationBoundarySubscriber | undefined
  let unregisters = 0
  const runtime: SsrNavigationRuntime = {
    subscribe: () => () => undefined,
    registerBoundary(subscriber) {
      boundary = subscriber
      return () => {
        if (boundary === subscriber) boundary = undefined
        unregisters += 1
      }
    },
    dispose: () => undefined,
  }
  return {
    runtime,
    boundary: () => boundary!,
    unregisters: () => unregisters,
  }
}

describe('RouteSuspense', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const mountBoundary = (delay = 120) => {
    const harness = runtimeHarness()
    const root = document.createElement('div')
    const app = createApp(
      defineComponent({
        setup: () => () =>
          h(
            RouteSuspense,
            { delay },
            {
              default: () => h('button', { class: 'page' }, 'Current page'),
              fallback: () => h('div', { class: 'fallback' }, 'Loading page'),
            }
          ),
      })
    )
    app.provide(SSR_NAVIGATION_RUNTIME, harness.runtime)
    app.mount(root)
    return { app, root, harness }
  }

  it('shows fallback only after the delay and clears it on success', async () => {
    const { app, root, harness } = mountBoundary()
    harness.boundary().start(transaction())
    await vi.advanceTimersByTimeAsync(119)
    await nextTick()
    expect(root.querySelector('.fallback')).toBeNull()

    await vi.advanceTimersByTimeAsync(1)
    await nextTick()
    expect(root.querySelector('.fallback')?.textContent).toBe('Loading page')
    expect(root.querySelector('.vssl-route-suspense')?.getAttribute('aria-busy')).toBe('true')
    const content = root.querySelector('.vssl-route-suspense__content')
    expect(content?.hasAttribute('inert')).toBe(true)
    expect((content as HTMLElement).style.pointerEvents).toBe('none')
    expect(root.querySelector('.page')).not.toBeNull()

    harness.boundary().settle(1)
    await nextTick()
    expect(root.querySelector('.fallback')).toBeNull()
    expect(root.querySelector('.page')).not.toBeNull()
    expect(content?.hasAttribute('inert')).toBe(false)
    expect((content as HTMLElement).style.pointerEvents).toBe('')
    app.unmount()
  })

  it('never flashes fallback for a fast navigation', async () => {
    const { app, root, harness } = mountBoundary()
    harness.boundary().start(transaction())
    harness.boundary().settle(1)
    await vi.runAllTimersAsync()
    await nextTick()

    expect(root.querySelector('.fallback')).toBeNull()
    app.unmount()
  })

  it('keeps normal content visible when no fallback slot is supplied', async () => {
    const harness = runtimeHarness()
    const root = document.createElement('div')
    const app = createApp({
      render: () =>
        h(
          RouteSuspense,
          { delay: 0 },
          { default: () => h('main', { class: 'page' }, 'Current page') }
        ),
    })
    app.provide(SSR_NAVIGATION_RUNTIME, harness.runtime)
    app.mount(root)

    harness.boundary().start(transaction())
    await vi.runAllTimersAsync()
    await nextTick()

    expect(root.querySelector('.page')?.textContent).toBe('Current page')
    expect(root.querySelector('.vssl-route-suspense__fallback')).toBeNull()
    app.unmount()
  })

  it('keeps the original delay timer when navigation is superseded', async () => {
    const { app, root, harness } = mountBoundary()
    harness.boundary().start(transaction(1))
    await vi.advanceTimersByTimeAsync(80)
    harness.boundary().start(transaction(2))
    await vi.advanceTimersByTimeAsync(40)
    await nextTick()

    expect(root.querySelector('.fallback')).not.toBeNull()
    harness.boundary().settle(1)
    await nextTick()
    expect(root.querySelector('.fallback')).not.toBeNull()
    harness.boundary().settle(2)
    app.unmount()
  })

  it('preserves the current component instance and state after cancellation', async () => {
    let setups = 0
    let unmounts = 0
    const count = ref(0)
    const Page = defineComponent({
      setup() {
        setups += 1
        return () =>
          h(
            'button',
            {
              class: 'stateful-page',
              onVnodeUnmounted: () => {
                unmounts += 1
              },
              onClick: () => {
                count.value += 1
              },
            },
            String(count.value)
          )
      },
    })
    const harness = runtimeHarness()
    const root = document.createElement('div')
    const app = createApp({
      render: () =>
        h(
          RouteSuspense,
          { delay: 0 },
          {
            default: () => h(Page),
            fallback: () => h('div', { class: 'fallback' }, 'Loading'),
          }
        ),
    })
    app.provide(SSR_NAVIGATION_RUNTIME, harness.runtime)
    app.mount(root)
    ;(root.querySelector('.stateful-page') as HTMLButtonElement).click()
    await nextTick()

    harness.boundary().start(transaction())
    await vi.runAllTimersAsync()
    harness.boundary().settle(1)
    await nextTick()

    expect(setups).toBe(1)
    expect(unmounts).toBe(0)
    expect(root.querySelector('.stateful-page')?.textContent).toBe('1')
    app.unmount()
  })

  it('registers the injected RouterView depth and unregisters on unmount', () => {
    const harness = runtimeHarness()
    const root = document.createElement('div')
    const app = createApp({ render: () => h(RouteSuspense) })
    app.provide(SSR_NAVIGATION_RUNTIME, harness.runtime)
    app.provide(viewDepthKey, ref(2))
    app.mount(root)

    expect(harness.boundary().depth).toBe(2)
    app.unmount()
    expect(harness.unregisters()).toBe(1)
  })

  it('renders only normal content during SSR and hydrates without a fallback flash', async () => {
    const Root = defineComponent({
      setup: () => () =>
        h(
          RouteSuspense,
          null,
          {
            default: () => h('main', { class: 'page' }, 'Server page'),
            fallback: () => h('div', { class: 'fallback' }, 'Loading'),
          }
        ),
    })
    const html = await renderToString(createSSRApp(Root))
    expect(html).toContain('Server page')
    expect(html).not.toContain('Loading')

    const harness = runtimeHarness()
    const root = document.createElement('div')
    root.innerHTML = html
    const app = createSSRApp(Root)
    app.provide(SSR_NAVIGATION_RUNTIME, harness.runtime)
    app.mount(root)
    await nextTick()

    expect(root.querySelector('.page')?.textContent).toBe('Server page')
    expect(root.querySelector('.fallback')).toBeNull()
    app.unmount()
  })
})
