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
    pageReady: () => undefined,
    pageRendered: () => undefined,
    appMounted: () => undefined,
    whenPageReady: async () => true,
    isPageCurrent: () => true,
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

  it('uses the light and dark theme defaults through the public color variable', async () => {
    const { app, root, runtime } = mountIndicator()
    runtime.subscriber().start(transaction(1))
    await vi.advanceTimersByTimeAsync(120)
    await nextTick()

    const bar = root.querySelector('.vssl-loading-indicator__bar') as HTMLElement
    const styles = root.querySelector('style')?.textContent ?? ''
    expect(bar.style.background).toContain('--vssl-loading-indicator-color')
    expect(styles).toContain(':root{--vssl-loading-indicator-default-color:#3B82F6}')
    expect(styles).toContain('.dark,.dark-mode{--vssl-loading-indicator-default-color:#3B82F6}')

    app.unmount()
  })

  it('keeps an explicit global color override authoritative in dark mode', async () => {
    const applicationStyles = document.createElement('style')
    applicationStyles.textContent = ':root { --vssl-loading-indicator-color: rgb(255, 0, 0); }'
    document.head.appendChild(applicationStyles)
    document.body.classList.add('dark')
    const runtime = harness()
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp({ render: () => h(LoadingIndicator, { delay: 0 }) })
    app.provide(SSR_NAVIGATION_RUNTIME, runtime.runtime)
    app.mount(root)

    runtime.subscriber().start(transaction(1))
    await nextTick()

    const bar = root.querySelector('.vssl-loading-indicator__bar') as HTMLElement
    const globalColor = (element: Element) =>
      getComputedStyle(element)
        .getPropertyValue('--vssl-loading-indicator-color')
        .replace(/\s+/g, '')
    expect(globalColor(document.documentElement)).toBe('rgb(255,0,0)')
    expect(globalColor(document.body)).toBe('rgb(255,0,0)')
    expect(bar.style.background).toContain('var(--vssl-loading-indicator-color')

    app.unmount()
    root.remove()
    applicationStyles.remove()
    document.body.classList.remove('dark')
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
