import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createRouter, RouterView, type RouterHistory } from 'vue-router'
import { readSsrRequestBootstrap } from '../../../src/browser/SsrBrowserBootstrap'
import { renderSsrApplication } from '../../../src/rendering/SsrRenderRuntime'
import { createTestRenderRequest } from '../../helpers/SsrTestFixtures'
import { requiresSsrMiddlewareRuntime } from '../../../src/middleware/SsrMiddlewarePresence'

const Page = defineComponent({ render: () => h('main', 'page') })
const Root = defineComponent({ render: () => h(RouterView) })

describe('authoritative request bootstrap result', () => {
  it('isolates matched middleware across concurrent requests, aliases and custom routers', async () => {
    const middleware = vi.fn(() => undefined)
    const definition = { id: 'app', root: Root, seo: { enabled: false }, router: ({ history }: { history: RouterHistory }) => createRouter({ history, routes: [
      { path: '/', component: Page },
      { path: '/guarded', alias: '/alias', component: Page, meta: { middleware: [middleware] } },
    ] }) }
    const [plain, guarded] = await Promise.all(['/', '/alias'].map((path) => renderSsrApplication(definition,
      createTestRenderRequest('bootstrap.test', { url: `https://bootstrap.test${path}` }))))
    expect(readSsrRequestBootstrap(plain)).toEqual(['navigation'])
    expect(readSsrRequestBootstrap(guarded)).toEqual(['navigation', 'middleware'])
    expect(middleware).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(guarded)).not.toContain('request-bootstrap')
    expect(JSON.stringify(guarded.hydrationState)).not.toContain('middleware')
    expect(readSsrRequestBootstrap({})).toEqual([])
  })

  it('shares presence semantics without evaluating middleware metadata getters', () => {
    const getter = vi.fn(() => [])
    const meta = Object.defineProperty({}, 'middleware', { get: getter })
    expect(requiresSsrMiddlewareRuntime([], { matched: [{ meta }] } as never)).toBe(true)
    expect(getter).not.toHaveBeenCalled()
    expect(requiresSsrMiddlewareRuntime([], { matched: [{ meta: {} }] } as never)).toBe(false)
  })

  it('retains the initial executor requirement for middleware cancellation', async () => {
    const result = await renderSsrApplication({ id: 'app', root: Root, seo: { enabled: false }, routes: [
      { path: '/', component: Page, meta: { middleware: [() => false] } },
    ] }, createTestRenderRequest('bootstrap.test'))
    expect(readSsrRequestBootstrap(result)).toEqual(['navigation', 'middleware'])
  })
})
