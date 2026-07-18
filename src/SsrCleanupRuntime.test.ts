import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createSsrApplication } from './SsrApplicationRuntime'
import { renderSsrApplication } from './SsrRenderRuntime'

const request = () => ({
  requestId: 'cleanup',
  url: 'https://cleanup.test/',
  host: 'cleanup.test',
  protocol: 'https' as const,
  method: 'GET',
  headers: {},
  publicConfig: {},
  signal: new AbortController().signal,
})

// The runtime owns no API client. Installed plugins register their own teardown
// through the generic hydration contract, and the runtime guarantees every
// registered disposer runs regardless of how the request ends.
describe('SSR generic hydration cleanup', () => {
  it('disposes registered plugin state when application installation fails', async () => {
    const dispose = vi.fn()
    await expect(createSsrApplication({
      id: 'install-failure',
      rootComponent: defineComponent(() => () => h('main')),
      install: ({ hydration }) => {
        hydration.onDispose(dispose)
        throw new Error('install failed')
      },
    }, { server: true, request: request() })).rejects.toThrow('install failed')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes plugin state after render failure even when consumer cleanup also throws', async () => {
    const dispose = vi.fn()
    const cleanup = vi.fn(() => { throw new Error('cleanup failed') })
    await expect(renderSsrApplication({
      id: 'render-failure',
      rootComponent: defineComponent({
        setup() { throw new Error('render failed') },
      }),
      install: ({ hydration }) => hydration.onDispose(dispose),
      cleanup,
    }, request())).rejects.toThrow('render failed')
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes plugin state and reports consumer cleanup failure after a successful render', async () => {
    const dispose = vi.fn()
    await expect(renderSsrApplication({
      id: 'cleanup-failure',
      rootComponent: defineComponent(() => () => h('main', 'rendered')),
      install: ({ hydration }) => hydration.onDispose(dispose),
      cleanup: () => { throw new Error('cleanup failed') },
    }, request())).rejects.toThrow('cleanup failed')
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
