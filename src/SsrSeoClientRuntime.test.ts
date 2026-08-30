// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { KeepAlive, computed, defineComponent, h, nextTick, ref } from 'vue'
import { RouterView, type Router } from 'vue-router'
import { useSeo } from './extensions/seo/useSeo'
import { createSsrApplication } from './SsrApplicationRuntime'
import {
  resolveResponseStatusForRoute,
  redirectTo,
  setHttpStatus,
} from './SsrResponseStatus'
import { createTestRenderRequest } from './SsrTestFixtures'

const flushHead = async () => {
  await Promise.resolve()
  await nextTick()
}

const waitForPath = async (router: Router, path: string) => {
  if (router.currentRoute.value.path === path) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${path}`))
    }, 1000)
    const stop = router.afterEach((to) => {
      if (to.path === path) {
        clearTimeout(timer)
        stop()
        resolve()
      }
    })
  })
}

const mountClient = async (definition: Parameters<typeof createSsrApplication>[0], path = '/') => {
  window.history.replaceState({}, '', path)
  document.head.innerHTML = ''
  document.body.innerHTML = '<div id="app"></div>'
  const created = await createSsrApplication(definition, {
    server: false,
    spa: true,
    request: createTestRenderRequest('ex.test', {
      url: `https://ex.test${path}`,
      siteOrigin: 'https://ex.test',
    }),
  })
  if (created.router) {
    await created.router.push(path)
    await created.router.isReady()
    resolveResponseStatusForRoute(created.context.response, created.router.currentRoute.value)
  }
  created.app.mount('#app')
  created.managedHead.hydrate(document.head)
  await flushHead()
  return created
}

describe('reactive useSeo() in the browser', () => {
  it('finishes async application initialization before the first browser navigation', async () => {
    let initialized = false
    let enteredBeforeInitialization = false
    const created = await mountClient(
      {
        id: 'async-router-initialization',
        root: defineComponent({ setup: () => () => h(RouterView) }),
        routes: [
          {
            path: '/protected',
            component: defineComponent({
              setup: () => () => h('main', 'protected'),
            }),
            beforeEnter: () => {
              if (!initialized) enteredBeforeInitialization = true
            },
          },
        ],
        install: async ({ router }) => {
          await Promise.resolve()
          router?.beforeEach(() => {
            initialized = true
          })
        },
      },
      '/protected'
    )

    expect(created.router!.currentRoute.value.path).toBe('/protected')
    expect(enteredBeforeInitialization).toBe(false)
    created.hydration.dispose()
    created.app.unmount()
  })

  it('updates document.title when a Ref changes after mount', async () => {
    const title = ref('Initial')
    const created = await mountClient({
      id: 'seo-ref',
      root: defineComponent({ setup: () => () => h(RouterView) }),
      routes: [
        {
          path: '/',
          component: defineComponent({
            setup() {
              useSeo({ title })
              return () => h('main', title.value)
            },
          }),
        },
      ],
      seo: { siteUrl: 'https://ex.test' },
    })
    expect(document.title).toBe('Initial')
    title.value = 'Updated'
    await flushHead()
    expect(document.title).toBe('Updated')
    created.hydration.dispose()
    created.app.unmount()
  })

  it('updates metadata when a Computed changes after mount', async () => {
    const name = ref('Ada')
    const description = computed(() => `${name.value} profile`)
    const created = await mountClient({
      id: 'seo-computed',
      root: defineComponent({ setup: () => () => h(RouterView) }),
      routes: [
        {
          path: '/',
          component: defineComponent({
            setup() {
              useSeo({ title: 'Profile', description })
              return () => h('main', name.value)
            },
          }),
        },
      ],
      seo: { siteUrl: 'https://ex.test' },
    })
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      'Ada profile'
    )
    name.value = 'Grace'
    await flushHead()
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(
      'Grace profile'
    )
    created.hydration.dispose()
    created.app.unmount()
  })

  it('updates head when getter dependencies change', async () => {
    const city = ref('Oslo')
    const created = await mountClient({
      id: 'seo-getter',
      root: defineComponent({ setup: () => () => h(RouterView) }),
      routes: [
        {
          path: '/',
          component: defineComponent({
            setup() {
              useSeo({ title: () => `${city.value} weather` })
              return () => h('main', city.value)
            },
          }),
        },
      ],
      seo: { siteUrl: 'https://ex.test' },
    })
    expect(document.title).toBe('Oslo weather')
    city.value = 'Bergen'
    await flushHead()
    expect(document.title).toBe('Bergen weather')
    created.hydration.dispose()
    created.app.unmount()
  })

  it('reconciles multiple reactive changes in one tick into one snapshot', async () => {
    const title = ref('One')
    const created = await mountClient({
      id: 'seo-batch',
      root: defineComponent({ setup: () => () => h(RouterView) }),
      routes: [
        {
          path: '/',
          component: defineComponent({
            setup() {
              useSeo({ title })
              return () => h('main', title.value)
            },
          }),
        },
      ],
      seo: { siteUrl: 'https://ex.test' },
    })
    let commits = 0
    const observer = new MutationObserver(() => {
      commits += 1
    })
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    title.value = 'Two'
    title.value = 'Three'
    await flushHead()
    observer.disconnect()
    expect(document.title).toBe('Three')
    expect(commits).toBe(1)
    created.hydration.dispose()
    created.app.unmount()
  })

  it('does not let a deactivated KeepAlive page become authoritative', async () => {
    const homeTitle = ref('Home')
    const aboutTitle = ref('About')
    const created = await mountClient({
      id: 'seo-keepalive',
      root: defineComponent({
        setup: () => () => h(KeepAlive, null, { default: () => h(RouterView) }),
      }),
      routes: [
        {
          path: '/',
          component: defineComponent({
            name: 'Home',
            setup() {
              useSeo({ title: homeTitle })
              return () => h('main', 'home')
            },
          }),
        },
        {
          path: '/about',
          component: defineComponent({
            name: 'About',
            setup() {
              useSeo({ title: aboutTitle })
              return () => h('main', 'about')
            },
          }),
        },
      ],
      seo: { siteUrl: 'https://ex.test' },
    })
    expect(document.title).toBe('Home')
    await created.router!.push('/about')
    await flushHead()
    expect(document.title).toBe('About')
    homeTitle.value = 'Stale home'
    await flushHead()
    expect(document.title).toBe('About')
    aboutTitle.value = 'Latest about'
    await flushHead()
    expect(document.title).toBe('Latest about')
    await created.router!.push('/')
    await flushHead()
    expect(document.title).toBe('Stale home')
    created.hydration.dispose()
    created.app.unmount()
  })
})

describe('scoped whole-object useSeo status', () => {
  it('reacts, outranks route status, and resets after navigation/unmount', async () => {
    const status = ref(404)
    const created = await mountClient(
      {
        id: 'scoped-status',
        root: defineComponent({ setup: () => () => h(RouterView) }),
        routes: [
          {
            path: '/article',
            meta: { seo: { status: 410 } },
            component: defineComponent({
              setup() {
                useSeo(computed(() => ({ title: `Status ${status.value}`, status: status.value })))
                return () => h('main', 'article')
              },
            }),
          },
          {
            path: '/',
            component: defineComponent({
              setup() {
                useSeo({ title: 'Home' })
                return () => h('main', 'home')
              },
            }),
          },
        ],
        seo: { siteUrl: 'https://ex.test' },
      },
      '/article'
    )
    expect(created.context.response.statusCode).toBe(404)
    expect(document.title).toBe('Status 404')
    status.value = 200
    await flushHead()
    expect(created.context.response.statusCode).toBe(200)
    expect(document.title).toBe('Status 200')
    await created.router!.push('/')
    await flushHead()
    expect(created.context.response.statusCode).toBe(200)
    expect(document.title).toBe('Home')
    created.hydration.dispose()
    created.app.unmount()
  })

  it('replays a persistent layout status across child navigation and history', async () => {
    const status = ref(404)
    const Layout = defineComponent({
      setup() {
        useSeo(computed(() => ({ title: 'Persistent shell', status: status.value })))
        return () => h(RouterView)
      },
    })
    const Page = (label: string) => defineComponent(() => () => h('main', label))
    const Imperative = defineComponent({
      setup() {
        setHttpStatus(418)
        return () => h('main', 'override')
      },
    })
    const created = await mountClient(
      {
        id: 'persistent-status',
        root: defineComponent({ setup: () => () => h(RouterView) }),
        routes: [
          {
            path: '/shell',
            component: Layout,
            children: [
              { path: 'one', component: Page('one') },
              {
                path: 'two',
                component: Page('two'),
                meta: { seo: { status: 410 } },
              },
              { path: 'override', component: Imperative },
            ],
          },
          { path: '/outside', component: Page('outside') },
        ],
        seo: { siteUrl: 'https://ex.test' },
      },
      '/shell/one'
    )

    expect(created.context.response.statusCode).toBe(404)
    await created.router!.push('/shell/two')
    await flushHead()
    expect(created.context.response.statusCode).toBe(404)

    status.value = 200
    await flushHead()
    expect(created.context.response.statusCode).toBe(200)

    created.router!.back()
    await waitForPath(created.router!, '/shell/one')
    await flushHead()
    expect(created.context.response.statusCode).toBe(200)
    created.router!.forward()
    await waitForPath(created.router!, '/shell/two')
    await flushHead()
    expect(created.context.response.statusCode).toBe(200)

    await created.router!.push('/shell/override')
    await flushHead()
    expect(created.context.response.statusCode).toBe(418)
    status.value = 404
    await flushHead()
    expect(created.context.response.statusCode).toBe(418)

    await created.router!.push('/outside')
    await flushHead()
    expect(created.context.response.statusCode).toBe(200)
    created.hydration.dispose()
    created.app.unmount()
  })

  it('keeps redirectTo as a non-throwing browser no-op', async () => {
    const created = await mountClient({
      id: 'browser-redirect-noop',
      root: defineComponent({
        setup() {
          redirectTo('javascript:alert(1)')
          return () => h('main', 'still here')
        },
      }),
      seo: { siteUrl: 'https://ex.test' },
    })
    expect(created.context.response.redirect).toBeNull()
    expect(document.body.textContent).toContain('still here')
    created.hydration.dispose()
    created.app.unmount()
  })
})

describe('browser HTML attribute reconciliation', () => {
  it('updates and clears owned attributes without touching template attributes', async () => {
    document.documentElement.removeAttribute('lang')
    document.documentElement.removeAttribute('dir')
    document.documentElement.setAttribute('data-theme', 'dark')
    const language = ref<string | null>('ar')
    const direction = ref<string | null>('rtl')
    const created = await mountClient({
      id: 'html-attributes',
      root: defineComponent({ setup: () => () => h(RouterView) }),
      routes: [
        {
          path: '/',
          component: defineComponent({
            setup() {
              useSeo({ htmlAttributes: { lang: 'en', dir: 'ltr' } })
              return () => h('main', 'English')
            },
          }),
        },
        {
          path: '/arabic',
          component: defineComponent({
            setup() {
              useSeo(computed(() => ({
                htmlAttributes: { lang: language.value, dir: direction.value },
              })))
              return () => h('main', 'Arabic')
            },
          }),
        },
      ],
      seo: { siteUrl: 'https://ex.test' },
    })

    expect(document.documentElement.getAttribute('lang')).toBe('en')
    expect(document.documentElement.getAttribute('dir')).toBe('ltr')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    await created.router!.push('/arabic')
    await flushHead()
    expect(document.documentElement.getAttribute('lang')).toBe('ar')
    expect(document.documentElement.getAttribute('dir')).toBe('rtl')

    language.value = 'fa'
    direction.value = 'ltr'
    await flushHead()
    expect(document.documentElement.getAttribute('lang')).toBe('fa')
    expect(document.documentElement.getAttribute('dir')).toBe('ltr')

    language.value = null
    direction.value = null
    await flushHead()
    expect(document.documentElement.hasAttribute('lang')).toBe(false)
    expect(document.documentElement.hasAttribute('dir')).toBe(false)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    created.hydration.dispose()
    created.app.unmount()
    document.documentElement.removeAttribute('data-theme')
  })
})

describe('browser response status across navigation', () => {
  const robots = () => document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? ''

  it('resets meta.seo.status 404 to 200 on a normal route', async () => {
    const created = await mountClient(
      {
        id: 'status-meta',
        root: defineComponent({ setup: () => () => h(RouterView) }),
        routes: [
          {
            path: '/',
            component: defineComponent({
              setup() {
                useSeo({ title: 'Home', index: true })
                return () => h('main', 'home')
              },
            }),
          },
          {
            path: '/missing',
            component: defineComponent({
              setup() {
                useSeo({ title: 'Missing' })
                return () => h('main', 'missing')
              },
            }),
            meta: { seo: { status: 404 } },
          },
        ],
        seo: { siteUrl: 'https://ex.test' },
      },
      '/missing'
    )
    expect(created.context.response.statusCode).toBe(404)
    expect(robots()).toContain('noindex')
    await created.router!.push('/')
    await flushHead()
    expect(created.context.response.statusCode).toBe(200)
    expect(document.title).toBe('Home')
    expect(robots()).not.toContain('noindex')
    created.hydration.dispose()
    created.app.unmount()
  })

  it('clears setHttpStatus(404) when navigating to a normal route', async () => {
    const created = await mountClient(
      {
        id: 'status-runtime',
        root: defineComponent({ setup: () => () => h(RouterView) }),
        routes: [
          {
            path: '/',
            component: defineComponent({
              setup() {
                useSeo({ title: 'Home', index: true })
                return () => h('main', 'home')
              },
            }),
          },
          {
            path: '/gone',
            component: defineComponent({
              setup() {
                setHttpStatus(404)
                useSeo({ title: 'Gone', index: true })
                return () => h('main', 'gone')
              },
            }),
          },
        ],
        seo: { siteUrl: 'https://ex.test' },
      },
      '/gone'
    )
    expect(created.context.response.statusCode).toBe(404)
    expect(robots()).toContain('noindex')
    await created.router!.push('/')
    await flushHead()
    expect(created.context.response.statusCode).toBe(200)
    expect(document.title).toBe('Home')
    expect(robots()).not.toContain('noindex')
    created.hydration.dispose()
    created.app.unmount()
  })

  it('restores indexable SEO after leaving a 404 page', async () => {
    const created = await mountClient(
      {
        id: 'status-indexable',
        root: defineComponent({ setup: () => () => h(RouterView) }),
        routes: [
          {
            path: '/',
            component: defineComponent({
              setup() {
                useSeo({ title: 'Home', index: true, follow: true })
                return () => h('main', 'home')
              },
            }),
          },
          {
            path: '/missing',
            component: defineComponent({
              setup() {
                setHttpStatus(404)
                useSeo({ title: 'Missing', index: true })
                return () => h('main', 'missing')
              },
            }),
          },
        ],
        seo: { siteUrl: 'https://ex.test' },
      },
      '/missing'
    )
    expect(robots()).toContain('noindex')
    await created.router!.push('/')
    await flushHead()
    expect(created.context.response.statusCode).toBe(200)
    expect(robots()).toMatch(/index/)
    expect(robots()).not.toContain('noindex')
    created.hydration.dispose()
    created.app.unmount()
  })

  it('restores the correct route status on Back and Forward', async () => {
    const created = await mountClient({
      id: 'status-history',
      root: defineComponent({ setup: () => () => h(RouterView) }),
      routes: [
        {
          path: '/',
          component: defineComponent({
            setup() {
              useSeo({ title: 'Home' })
              return () => h('main', 'home')
            },
          }),
        },
        {
          path: '/missing',
          component: defineComponent({
            setup() {
              useSeo({ title: 'Missing' })
              return () => h('main', 'missing')
            },
          }),
          meta: { seo: { status: 404 } },
        },
      ],
      seo: { siteUrl: 'https://ex.test' },
    })
    expect(created.context.response.statusCode).toBe(200)
    await created.router!.push('/missing')
    await flushHead()
    expect(created.context.response.statusCode).toBe(404)
    await created.router!.push('/')
    await flushHead()
    expect(created.context.response.statusCode).toBe(200)
    created.router!.back()
    await waitForPath(created.router!, '/missing')
    await flushHead()
    expect(created.context.response.statusCode).toBe(404)
    created.router!.forward()
    await waitForPath(created.router!, '/')
    await flushHead()
    expect(created.context.response.statusCode).toBe(200)
    created.hydration.dispose()
    created.app.unmount()
  })

  it('lets a new runtime override win on the next route', async () => {
    const created = await mountClient({
      id: 'status-next-override',
      root: defineComponent({ setup: () => () => h(RouterView) }),
      routes: [
        {
          path: '/',
          component: defineComponent({
            setup() {
              useSeo({ title: 'Home' })
              return () => h('main', 'home')
            },
          }),
          meta: { seo: { status: 200 } },
        },
        {
          path: '/article',
          component: defineComponent({
            setup() {
              setHttpStatus(410)
              useSeo({ title: 'Gone article', index: true })
              return () => h('main', 'article')
            },
          }),
          meta: { seo: { status: 200 } },
        },
      ],
      seo: { siteUrl: 'https://ex.test' },
    })
    expect(created.context.response.statusCode).toBe(200)
    await created.router!.push('/article')
    await flushHead()
    expect(created.context.response.statusCode).toBe(410)
    expect(robots()).toContain('noindex')
    created.hydration.dispose()
    created.app.unmount()
  })

  it('resets Core status the same way when SEO is disabled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const created = await mountClient(
      {
        id: 'status-disabled',
        root: defineComponent({ setup: () => () => h(RouterView) }),
        routes: [
          {
            path: '/',
            component: defineComponent({
              setup() {
                useSeo({ title: 'Home' })
                return () => h('main', 'home')
              },
            }),
          },
          {
            path: '/missing',
            component: defineComponent({
              setup() {
                setHttpStatus(404)
                useSeo({ title: 'Missing' })
                return () => h('main', 'missing')
              },
            }),
            meta: { seo: { status: 404 } },
          },
        ],
        seo: { enabled: false },
      },
      '/missing'
    )
    expect(created.context.response.statusCode).toBe(404)
    await created.router!.push('/')
    await flushHead()
    expect(created.context.response.statusCode).toBe(200)
    expect(document.head.querySelector('title[data-vue-ssr-lite-head]')).toBeNull()
    warn.mockRestore()
    created.hydration.dispose()
    created.app.unmount()
  })

  it('does not apply a guarded 200 route when navigation is aborted from a 404 page', async () => {
    const created = await mountClient(
      {
        id: 'status-abort-from-404',
        root: defineComponent({ setup: () => () => h(RouterView) }),
        routes: [
          {
            path: '/missing',
            component: defineComponent({
              setup() {
                useSeo({ title: 'Missing', index: true })
                return () => h('main', 'missing')
              },
            }),
            meta: { seo: { status: 404 } },
          },
          {
            path: '/private',
            component: defineComponent({
              setup() {
                useSeo({ title: 'Private', index: true })
                return () => h('main', 'private')
              },
            }),
          },
        ],
        seo: { siteUrl: 'https://ex.test' },
        install({ router }) {
          router?.beforeEach((to) => {
            if (to.path === '/private') return false
          })
        },
      },
      '/missing'
    )
    expect(created.router!.currentRoute.value.path).toBe('/missing')
    expect(created.context.response.statusCode).toBe(404)
    expect(robots()).toContain('noindex')
    const failed = await created.router!.push('/private')
    expect(failed).toBeTruthy()
    await flushHead()
    expect(created.router!.currentRoute.value.path).toBe('/missing')
    expect(created.context.response.statusCode).toBe(404)
    expect(document.title).toBe('Missing')
    expect(robots()).toContain('noindex')
    created.hydration.dispose()
    created.app.unmount()
  })

  it('does not apply a guarded error route when navigation is aborted from a 200 page', async () => {
    const created = await mountClient({
      id: 'status-abort-from-200',
      root: defineComponent({ setup: () => () => h(RouterView) }),
      routes: [
        {
          path: '/',
          component: defineComponent({
            setup() {
              useSeo({ title: 'Home', index: true, follow: true })
              return () => h('main', 'home')
            },
          }),
        },
        {
          path: '/missing',
          component: defineComponent({
            setup() {
              useSeo({ title: 'Missing' })
              return () => h('main', 'missing')
            },
          }),
          meta: { seo: { status: 404 } },
        },
      ],
      seo: { siteUrl: 'https://ex.test' },
      install({ router }) {
        router?.beforeEach((to) => {
          if (to.path === '/missing') return false
        })
      },
    })
    expect(created.context.response.statusCode).toBe(200)
    expect(robots()).not.toContain('noindex')
    const failed = await created.router!.push('/missing')
    expect(failed).toBeTruthy()
    await flushHead()
    expect(created.router!.currentRoute.value.path).toBe('/')
    expect(created.context.response.statusCode).toBe(200)
    expect(document.title).toBe('Home')
    expect(robots()).not.toContain('noindex')
    created.hydration.dispose()
    created.app.unmount()
  })

  it('does not commit stale status from a cancelled navigation', async () => {
    let releasePending: ((value: boolean) => void) | undefined
    const created = await mountClient({
      id: 'status-cancelled',
      root: defineComponent({ setup: () => () => h(RouterView) }),
      routes: [
        {
          path: '/',
          component: defineComponent({
            setup() {
              useSeo({ title: 'Home', index: true })
              return () => h('main', 'home')
            },
          }),
        },
        {
          path: '/pending',
          component: defineComponent({
            setup() {
              useSeo({ title: 'Pending' })
              return () => h('main', 'pending')
            },
          }),
          meta: { seo: { status: 404 } },
        },
        {
          path: '/ok',
          component: defineComponent({
            setup() {
              useSeo({ title: 'OK', index: true })
              return () => h('main', 'ok')
            },
          }),
        },
      ],
      seo: { siteUrl: 'https://ex.test' },
      install({ router }) {
        router?.beforeEach(async (to) => {
          if (to.path !== '/pending') return true
          return await new Promise<boolean>((resolve) => {
            releasePending = resolve
          })
        })
      },
    })
    const pending = created.router!.push('/pending')
    await created.router!.push('/ok')
    releasePending?.(true)
    await pending
    await flushHead()
    expect(created.router!.currentRoute.value.path).toBe('/ok')
    expect(created.context.response.statusCode).toBe(200)
    expect(document.title).toBe('OK')
    expect(robots()).not.toContain('noindex')
    created.hydration.dispose()
    created.app.unmount()
  })

  it('keeps the active 200 page when a pending 404 is cancelled by an aborted later navigation', async () => {
    let releasePending: ((value: boolean) => void) | undefined
    const created = await mountClient({
      id: 'status-overlap-200',
      root: defineComponent({ setup: () => () => h(RouterView) }),
      routes: [
        {
          path: '/',
          component: defineComponent({
            setup() {
              useSeo({ title: 'Home', index: true, follow: true })
              return () => h('main', 'home')
            },
          }),
        },
        {
          path: '/pending',
          component: defineComponent({
            setup() {
              useSeo({ title: 'Pending' })
              return () => h('main', 'pending')
            },
          }),
          meta: { seo: { status: 404 } },
        },
        {
          path: '/blocked',
          component: defineComponent({
            setup() {
              useSeo({ title: 'Blocked' })
              return () => h('main', 'blocked')
            },
          }),
          meta: { seo: { status: 401 } },
        },
      ],
      seo: { siteUrl: 'https://ex.test' },
      install({ router }) {
        router?.beforeEach(async (to) => {
          if (to.path === '/pending') {
            return await new Promise<boolean>((resolve) => {
              releasePending = resolve
            })
          }
          if (to.path === '/blocked') return false
          return true
        })
      },
    })
    expect(created.context.response.statusCode).toBe(200)
    const pending = created.router!.push('/pending')
    const blocked = created.router!.push('/blocked')
    await blocked
    releasePending?.(true)
    await pending
    await flushHead()
    expect(created.router!.currentRoute.value.path).toBe('/')
    expect(created.context.response.statusCode).toBe(200)
    expect(document.title).toBe('Home')
    expect(robots()).not.toContain('noindex')
    created.hydration.dispose()
    created.app.unmount()
  })

  it('keeps the active 404 page when a pending 200 is cancelled by an aborted later navigation', async () => {
    let releasePending: ((value: boolean) => void) | undefined
    const created = await mountClient(
      {
        id: 'status-overlap-404',
        root: defineComponent({ setup: () => () => h(RouterView) }),
        routes: [
          {
            path: '/missing',
            component: defineComponent({
              setup() {
                useSeo({ title: 'Missing', index: true })
                return () => h('main', 'missing')
              },
            }),
            meta: { seo: { status: 404 } },
          },
          {
            path: '/pending',
            component: defineComponent({
              setup() {
                useSeo({ title: 'Pending', index: true })
                return () => h('main', 'pending')
              },
            }),
          },
          {
            path: '/blocked',
            component: defineComponent({
              setup() {
                useSeo({ title: 'Blocked' })
                return () => h('main', 'blocked')
              },
            }),
          },
        ],
        seo: { siteUrl: 'https://ex.test' },
        install({ router }) {
          router?.beforeEach(async (to) => {
            if (to.path === '/pending') {
              return await new Promise<boolean>((resolve) => {
                releasePending = resolve
              })
            }
            if (to.path === '/blocked') return false
            return true
          })
        },
      },
      '/missing'
    )
    expect(created.context.response.statusCode).toBe(404)
    expect(robots()).toContain('noindex')
    const pending = created.router!.push('/pending')
    const blocked = created.router!.push('/blocked')
    await blocked
    releasePending?.(true)
    await pending
    await flushHead()
    expect(created.router!.currentRoute.value.path).toBe('/missing')
    expect(created.context.response.statusCode).toBe(404)
    expect(document.title).toBe('Missing')
    expect(robots()).toContain('noindex')
    created.hydration.dispose()
    created.app.unmount()
  })
})
