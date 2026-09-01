// @vitest-environment jsdom
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  Teleport,
  type Component,
} from 'vue'
import {
  createRouter,
  createWebHistory,
  type Router,
  type RouterHistory,
  type RouteRecordRaw,
} from 'vue-router'
import { afterEach, describe, expect, it } from 'vitest'
import { mountSpaApplication } from './SsrBrowserRuntime'
import { createTestDomain } from './SsrTestFixtures'

interface OverlayFixture {
  root: Component
  routes: RouteRecordRaw[]
  createRouter: (history: RouterHistory) => Router
  navigation: {
    guards: number
  }
  lifecycle: {
    setups: number
    mounts: number
    unmounts: number
  }
}

const createOverlayFixture = (): OverlayFixture => {
  const lifecycle = {
    setups: 0,
    mounts: 0,
    unmounts: 0,
  }
  const navigation = {
    guards: 0,
  }
  const routes: RouteRecordRaw[] = [
    { path: '/', component: { render: () => null } },
  ]

  const root = defineComponent({
    name: 'ManagedSpaTeleportOverlayFixture',
    setup() {
      lifecycle.setups += 1
      onMounted(() => {
        lifecycle.mounts += 1
      })
      onUnmounted(() => {
        lifecycle.unmounts += 1
      })

      const open = ref(false)
      const selected = ref('none')
      const input = ref<HTMLInputElement | null>(null)

      const openOverlay = async () => {
        open.value = true
        await nextTick()
        input.value?.focus()
      }

      return () =>
        h('main', { id: 'overlay-fixture-root' }, [
          h(
            'button',
            {
              id: 'open-overlay',
              type: 'button',
              onClick: openOverlay,
            },
            'Open overlay'
          ),
          h('output', { id: 'selected-option' }, selected.value),
          open.value
            ? h(
                Teleport,
                { to: 'body' },
                h(
                  'section',
                  {
                    id: 'teleported-overlay',
                    role: 'dialog',
                    'aria-modal': 'false',
                  },
                  [
                    h('input', {
                      id: 'overlay-search',
                      ref: input,
                      'aria-label': 'Overlay search',
                    }),
                    h(
                      'button',
                      {
                        id: 'overlay-option',
                        type: 'button',
                        onClick: () => {
                          selected.value = 'selected'
                        },
                      },
                      'Select option'
                    ),
                    h(
                      'button',
                      {
                        id: 'close-overlay',
                        type: 'button',
                        onClick: () => {
                          open.value = false
                        },
                      },
                      'Close overlay'
                    ),
                  ]
                )
              )
            : null,
        ])
    },
  })

  return {
    root,
    routes,
    createRouter: (history) => {
      const router = createRouter({ history, routes })
      router.beforeEach(() => {
        navigation.guards += 1
        return true
      })
      return router
    },
    navigation,
    lifecycle,
  }
}

const click = async (selector: string) => {
  const element = document.querySelector<HTMLButtonElement>(selector)
  expect(element, `Expected ${selector} to exist`).not.toBeNull()
  element!.click()
  await nextTick()
  await Promise.resolve()
}

const exerciseOverlay = async (fixture: OverlayFixture) => {
  const mountTarget = document.getElementById('app')
  const navigationGuardsBeforeClicks = fixture.navigation.guards
  expect(mountTarget).not.toBeNull()

  await click('#open-overlay')
  const firstOverlay = document.getElementById('teleported-overlay')
  expect(firstOverlay?.parentElement).toBe(document.body)
  expect(document.activeElement?.id).toBe('overlay-search')

  await click('#overlay-option')
  expect(document.getElementById('teleported-overlay')).toBe(firstOverlay)
  expect(document.getElementById('selected-option')?.textContent).toBe(
    'selected'
  )

  await click('#close-overlay')
  expect(document.getElementById('teleported-overlay')).toBeNull()

  await click('#open-overlay')
  expect(document.getElementById('teleported-overlay')?.parentElement).toBe(
    document.body
  )
  expect(document.activeElement?.id).toBe('overlay-search')
  expect(document.getElementById('app')).toBe(mountTarget)
  expect(fixture.lifecycle).toEqual({ setups: 1, mounts: 1, unmounts: 0 })
  expect(fixture.navigation.guards).toBe(navigationGuardsBeforeClicks)
}

afterEach(() => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-mount-mode')
  window.history.replaceState({}, '', '/')
})

describe('SPA Teleport overlay lifecycle', () => {
  it('keeps a plain Vue SPA overlay focused and interactive across reopen', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    const fixture = createOverlayFixture()
    const router = fixture.createRouter(createWebHistory())
    const app = createApp(fixture.root)

    app.use(router)
    await router.isReady()
    app.mount('#app')

    try {
      await exerciseOverlay(fixture)
    } finally {
      app.unmount()
    }
    expect(fixture.lifecycle.unmounts).toBe(1)
  })

  it('keeps a managed SPA overlay focused and interactive across reopen', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    const fixture = createOverlayFixture()
    const mounted = await mountSpaApplication(
      {
        id: 'managed-overlay-regression',
        root: fixture.root,
        router: ({ history }) => fixture.createRouter(history),
        defaultRender: 'spa',
      },
      {
        domain: createTestDomain('overlay.test'),
        publicConfig: {},
        url: '/',
      }
    )

    try {
      await exerciseOverlay(fixture)
    } finally {
      mounted.unmount()
    }
    expect(fixture.lifecycle.unmounts).toBe(1)
  })
})
