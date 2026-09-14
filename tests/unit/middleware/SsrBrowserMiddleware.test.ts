// @vitest-environment jsdom
import { createApp, defineComponent, h } from 'vue'
import { createRouter, createMemoryHistory, isNavigationFailure, NavigationFailureType } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSsrBrowserMiddleware } from '../../../src/middleware/SsrBrowserMiddleware'
import * as execution from '../../../src/middleware/SsrMiddlewareRuntime'
import { createSsrApplication } from '../../../src/application/SsrApplicationRuntime'
import { createTestRenderRequest } from '../../helpers/SsrTestFixtures'
import { defineMiddleware } from '../../../src/middleware/defineMiddleware'

const cleanup: Array<() => void> = []
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.restoreAllMocks() })
const Page = defineComponent({ setup: () => () => h('main') })

const create = async () => {
  const request = createTestRenderRequest('capability.test')
  const created = await createSsrApplication({ id: 'context', root: Page, seo: { enabled: false } }, { server: true, request })
  cleanup.push(() => created.hydration.dispose())
  const app = createApp(Page)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: Page }] })
  const controller = createSsrBrowserMiddleware({ server: false, request })
  controller.install({ app, router, context: created.context })
  cleanup.push(() => controller.dispose())
  await router.push('/')
  controller.completeBrowserBootstrap()
  return { app, router, controller, context: created.context }
}

describe('browser middleware activation', () => {
  it('leaves execution absent for a plain router, then honors addRoute, aliases and changed metadata', async () => {
    const factory = vi.spyOn(execution, 'createSsrMiddlewareExecutionController')
    const { router } = await create()
    expect(factory).not.toHaveBeenCalled()
    const middleware = vi.fn(() => undefined)
    router.addRoute({ path: '/added', alias: '/alias', component: Page, meta: { middleware: [defineMiddleware(middleware)] } })
    await router.push('/alias')
    expect(factory).toHaveBeenCalledTimes(1)
    expect(middleware).toHaveBeenCalledTimes(1)
    await router.push('/')
    const changedMiddleware = vi.fn(() => '/alias')
    router.getRoutes().find(route => route.path === '/')!.meta.middleware = [defineMiddleware(changedMiddleware)]
    await router.push('/added')
    await router.push('/')
    expect(changedMiddleware).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.path).toBe('/alias')
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('rolls props back before subsequently registered afterEach hooks observe a cancellation', async () => {
    const { router } = await create()
    router.addRoute({
      path: '/cancelled', component: Page, props: { marker: 'original' },
      meta: { middleware: [defineMiddleware(() => ({ props: { marker: 'temporary' } }))] },
    })
    const record = router.getRoutes().find(route => route.path === '/cancelled')!
    const original = record.props.default
    router.beforeEach(to => to.path === '/cancelled' ? false : true)
    const after = vi.fn(() => { expect(record.props.default).toBe(original) })
    router.afterEach(after)
    const failure = await router.push('/cancelled')
    expect(isNavigationFailure(failure, NavigationFailureType.aborted)).toBe(true)
    expect(router.currentRoute.value.path).toBe('/')
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('retains validation when route middleware is introduced after installation', async () => {
    const { router } = await create()
    router.addRoute({ path: '/invalid', component: Page, meta: { middleware: null as never } })
    router.onError(() => {})
    await expect(router.push('/invalid')).rejects.toThrow('meta.middleware must be an array')
  })

  it('cancels superseded work once the executor has activated', async () => {
    const { router } = await create()
    router.addRoute({ path: '/other', component: Page })
    let release!: () => void
    let began!: () => void
    let signal!: AbortSignal
    const started = new Promise<void>(resolve => { began = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    router.addRoute({ path: '/slow', component: Page, meta: { middleware: [defineMiddleware(async context => {
      signal = context.signal
      began()
      await gate
    })] } })
    const slow = router.push('/slow')
    await started
    await router.push('/other')
    expect(signal.aborted).toBe(true)
    release()
    await slow
    expect(router.currentRoute.value.path).toBe('/other')
  })
})
