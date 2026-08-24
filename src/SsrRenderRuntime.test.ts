import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { RouterView, type RouteRecordRaw } from 'vue-router'
import { defineApplication, useSeo } from './index'
import { useSsrRequestContext } from './SsrRequestContext'
import { renderSsrApplication } from './SsrRenderRuntime'
import { createTestRenderRequest } from './SsrTestFixtures'

const Root = defineComponent({
  setup() {
    const context = useSsrRequestContext<{ value: string }, { label: string }>()
    useSeo({ title: context.publicConfig.label })
    return () => h('main', `${context.host}:${context.state.value}`)
  },
})

const routes: RouteRecordRaw[] = [{ path: '/:path(.*)*', component: Root }]
const application = defineApplication({
  id: 'isolation',
  root: defineComponent({ setup: () => () => h(RouterView) }),
  routes,
  createInitialState: () => ({ value: '' }),
  install({ context }) {
    context.state.value = context.host
  },
})

const request = (host: string) =>
  createTestRenderRequest(host, {
    url: `https://${host}/page`,
    publicConfig: { label: host },
  })

describe('SSR request isolation', () => {
  it('isolates concurrent Vue, router, state, head, and request contexts', async () => {
    const [left, right] = await Promise.all([
      renderSsrApplication(application, request('left.test')),
      renderSsrApplication(application, request('right.test')),
    ])
    expect(left.hydrationState.application.value).toBe('left.test')
    expect(right.hydrationState.application.value).toBe('right.test')
    expect(left.html).toContain('left.test:left.test')
    expect(right.html).toContain('right.test:right.test')
    expect(left.head.title).toBe('left.test')
    expect(right.head.title).toBe('right.test')
    expect(left.hydrationState).not.toBe(right.hydrationState)
    expect(left.metrics.requestId).toBe('left.test')
    expect(right.metrics.requestId).toBe('right.test')
  })

  it('returns 404 when the router has no matching route', async () => {
    const unmatched = defineApplication({
      id: 'unmatched',
      root: defineComponent({ setup: () => () => h(RouterView) }),
      routes: [{ path: '/', component: Root }],
      createInitialState: () => ({ value: '' }),
    })

    const rendered = await renderSsrApplication(
      unmatched,
      request('missing.test')
    )
    expect(rendered.response.statusCode).toBe(404)
  })
})
