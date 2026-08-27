import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createSsrApplication } from './SsrApplicationRuntime'
import { renderSsrApplication } from './SsrRenderRuntime'
import { createTestRenderRequest } from './SsrTestFixtures'

const request = () =>
  createTestRenderRequest('cleanup.test', { requestId: 'cleanup' })

// The runtime owns no API client. Installed plugins register their own teardown
// through the generic hydration contract, and the runtime guarantees every
// registered disposer runs regardless of how the request ends.
describe('SSR generic hydration cleanup', () => {
  it('disposes registered plugin state when application installation fails', async () => {
    const dispose = vi.fn()
    await expect(createSsrApplication({
      id: 'install-failure',
      root: defineComponent(() => () => h('main')),
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
      root: defineComponent({
        setup() { throw new Error('render failed') },
      }),
      install: ({ hydration }) => hydration.onDispose(dispose),
      cleanup,
    }, request())).rejects.toThrow('render failed')
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes plugin state without replacing a successful render when cleanup fails', async () => {
    const dispose = vi.fn()
    const result = await renderSsrApplication({
      id: 'cleanup-failure',
      root: defineComponent(() => () => h('main', 'rendered')),
      install: ({ hydration }) => hydration.onDispose(dispose),
      cleanup: () => { throw new Error('cleanup failed') },
    }, request())
    expect(result.html).toContain('rendered')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('runs main.ts before extension setup', async () => {
    const order: string[] = []
    await createSsrApplication(
      {
        id: 'lifecycle-order',
        root: defineComponent(() => () => h('main')),
        install: () => {
          order.push('main')
        },
        extensions: [
          {
            name: 'probe',
            setup() {
              order.push('extension')
            },
          },
        ],
      },
      { server: true, request: request() }
    )
    expect(order[0]).toBe('main')
    expect(order.indexOf('main')).toBeLessThan(order.indexOf('extension'))
  })

  it('does not set up extensions when main.ts fails, and still disposes install work', async () => {
    const dispose = vi.fn()
    let extensionSetup = false
    await expect(
      createSsrApplication(
        {
          id: 'lifecycle-install-failure',
          root: defineComponent(() => () => h('main')),
          install: ({ hydration }) => {
            hydration.onDispose(dispose)
            throw new Error('install failed')
          },
          extensions: [
            {
              name: 'probe',
              setup() {
                extensionSetup = true
              },
            },
          ],
        },
        { server: true, request: request() }
      )
    ).rejects.toThrow('install failed')
    expect(extensionSetup).toBe(false)
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
