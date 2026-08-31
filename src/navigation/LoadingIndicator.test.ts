// @vitest-environment jsdom
import { renderToString } from '@vue/server-renderer'
import { createApp, createSSRApp, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoadingIndicator } from './LoadingIndicator'
import { SSR_NAVIGATION_RUNTIME } from './SsrNavigationRuntime'
import type {
  SsrNavigationRuntime,
  SsrNavigationSubscriber,
  SsrNavigationTransaction,
} from './SsrNavigationTypes'

const transaction = (id: number): SsrNavigationTransaction =>
  ({
    id,
    from: {},
    to: {},
    changedDepth: 0,
    startedAt: Date.now(),
  }) as unknown as SsrNavigationTransaction

const harness = () => {
  let subscriber: SsrNavigationSubscriber | undefined
  let cleanups = 0
  const runtime: SsrNavigationRuntime = {
    subscribe(value) {
      subscriber = value
      return () => {
        subscriber = undefined
        cleanups += 1
      }
    },
    registerBoundary: () => () => undefined,
    dispose: () => undefined,
  }
  return {
    runtime,
    subscriber: () => subscriber!,
    cleanups: () => cleanups,
  }
}

describe('LoadingIndicator', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const mountIndicator = () => {
    const runtime = harness()
    const root = document.createElement('div')
    const app = createApp({
      render: () =>
        h(LoadingIndicator, {
          delay: 120,
          class: 'custom-indicator',
          style: { height: '5px' },
        }),
    })
    app.provide(SSR_NAVIGATION_RUNTIME, runtime.runtime)
    app.mount(root)
    return { app, root, runtime }
  }

  it('is hidden initially and skips fast navigations', async () => {
    const { app, root, runtime } = mountIndicator()
    expect(root.querySelector('[role="progressbar"]')).toBeNull()

    runtime.subscriber().start(transaction(1))
    runtime.subscriber().settle(1)
    await vi.runAllTimersAsync()
    await nextTick()

    expect(root.querySelector('[role="progressbar"]')).toBeNull()
    app.unmount()
  })

  it('appears after its delay, uses CSS animation, and settles', async () => {
    const { app, root, runtime } = mountIndicator()
    runtime.subscriber().start(transaction(1))
    await vi.advanceTimersByTimeAsync(120)
    await nextTick()

    const indicator = root.querySelector('[role="progressbar"]')
    expect(indicator?.classList.contains('custom-indicator')).toBe(true)
    expect((indicator as HTMLElement).style.height).toBe('5px')
    expect(root.querySelector('style')?.textContent).toContain('@keyframes vssl-loading-indicator')

    runtime.subscriber().settle(1)
    await nextTick()
    expect(root.querySelector('[role="progressbar"]')).toBeNull()
    app.unmount()
  })

  it('stays visible for a newer transaction when a stale one settles', async () => {
    const { app, root, runtime } = mountIndicator()
    runtime.subscriber().start(transaction(1))
    await vi.advanceTimersByTimeAsync(120)
    runtime.subscriber().start(transaction(2))
    runtime.subscriber().settle(1)
    await nextTick()

    expect(root.querySelector('[role="progressbar"]')).not.toBeNull()
    runtime.subscriber().settle(2)
    await nextTick()
    expect(root.querySelector('[role="progressbar"]')).toBeNull()
    app.unmount()
  })

  it('keeps the original delay timer when navigation is superseded', async () => {
    const { app, root, runtime } = mountIndicator()
    runtime.subscriber().start(transaction(1))
    await vi.advanceTimersByTimeAsync(80)
    runtime.subscriber().start(transaction(2))
    await vi.advanceTimersByTimeAsync(40)
    await nextTick()

    expect(root.querySelector('[role="progressbar"]')).not.toBeNull()
    runtime.subscriber().settle(2)
    app.unmount()
  })

  it('cleans up its subscription and pending timer on unmount', () => {
    const { app, runtime } = mountIndicator()
    runtime.subscriber().start(transaction(1))
    expect(vi.getTimerCount()).toBe(1)

    app.unmount()

    expect(runtime.cleanups()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renders nothing during SSR', async () => {
    const html = await renderToString(
      createSSRApp({ render: () => h(LoadingIndicator) })
    )
    expect(html).not.toContain('progressbar')
    expect(html).not.toContain('vssl-loading-indicator')
  })
})
