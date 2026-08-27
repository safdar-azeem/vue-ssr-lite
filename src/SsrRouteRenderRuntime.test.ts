import { describe, expect, it } from 'vitest'
import { defineComponent } from 'vue'
import {
  createMemoryHistory,
  createRouter,
  type RouteRecordRaw,
} from 'vue-router'
import {
  createRouteRenderMatcher,
  resolveMatchedRenderMode,
  stripRouteForMatching,
  validateRouteRenderBoundaries,
} from './SsrRouteRenderRuntime'
import { discoverStaticSitemapPaths } from './extensions/seo/sitemap'

const Page = defineComponent({ name: 'Page', setup: () => () => null })

const hybridRoutes: RouteRecordRaw[] = [
  {
    path: '/',
    component: Page,
    meta: { render: 'ssr' },
  },
  {
    path: '/about',
    alias: '/about-us',
    component: Page,
    meta: { render: 'ssr' },
  },
  {
    path: '/legacy',
    redirect: '/about',
  },
  {
    path: '/go-app',
    redirect: '/app/projects',
  },
  {
    path: '/named',
    components: { default: Page, sidebar: Page },
    name: 'named-views',
  },
  {
    path: '/lazy',
    component: () => Promise.resolve(Page),
  },
  {
    path: '/app',
    component: Page,
    meta: { render: 'spa' },
    children: [
      { path: '', component: Page },
      { path: 'projects', component: Page },
      { path: 'projects/:id', component: Page },
      { path: 'go-public', redirect: '/about' },
      { path: 'settings', component: Page },
    ],
  },
  {
    path: '/admin',
    component: Page,
    meta: { render: 'spa', seo: { index: false } },
    children: [{ path: 'users', component: Page }],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'catch-all',
    component: Page,
  },
]

const expectedHybrid: Record<string, 'ssr' | 'spa'> = {
  '/': 'ssr',
  '/about': 'ssr',
  '/about-us': 'ssr',
  '/app': 'spa',
  '/app/projects': 'spa',
  '/app/settings': 'spa',
  '/admin': 'spa',
  '/admin/users': 'spa',
}

describe('route-level render selection', () => {
  it('inherits the nearest parent render mode', () => {
    expect(validateRouteRenderBoundaries(hybridRoutes, 'ssr', 'app')).toBe(true)
    const matched = [{ meta: { render: 'spa' } }, { meta: {} }] as never
    expect(resolveMatchedRenderMode(matched, 'ssr')).toBe('spa')
  })

  it('rejects nested SSR overrides under an SPA parent', () => {
    expect(() =>
      validateRouteRenderBoundaries(
        [
          {
            path: '/app',
            meta: { render: 'spa' },
            children: [{ path: 'public', meta: { render: 'ssr' } }],
          },
        ],
        'ssr',
        'website'
      )
    ).toThrow(/cannot override an SPA parent back to SSR/)
  })

  it('rejects invalid meta.render values', () => {
    expect(() =>
      validateRouteRenderBoundaries(
        [{ path: '/broken', meta: { render: 'static' as never } }],
        'ssr',
        'website'
      )
    ).toThrow(/meta.render must be "ssr" or "spa"/)
  })

  it('omits undefined alias so Vue Router can construct the matcher', () => {
    const stripped = stripRouteForMatching({
      path: '/about',
      component: Page,
      meta: { render: 'ssr' },
    })
    expect('alias' in stripped).toBe(false)
    expect(() =>
      createRouter({
        history: createMemoryHistory(),
        routes: [stripped],
      })
    ).not.toThrow()
  })

  it('starts and resolves the complete hybrid example route tree', () => {
    const matcher = createRouteRenderMatcher(hybridRoutes, 'ssr')
    for (const [url, mode] of Object.entries(expectedHybrid)) {
      expect(matcher.resolve(url), url).toBe(mode)
    }
  })

  it('preserves alias, redirect, params, named views, lazy components, and catch-all matching', () => {
    const matcher = createRouteRenderMatcher(hybridRoutes, 'ssr')
    expect(matcher.resolve('/about-us')).toBe('ssr')
    expect(matcher.resolve('/app/projects/alpha')).toBe('spa')
    expect(matcher.resolve('/named')).toBe('ssr')
    expect(matcher.resolve('/lazy')).toBe('ssr')
    expect(matcher.resolve('/missing-page')).toBe('ssr')
  })

  it('resolves mixed SSR/SPA URLs concurrently without cross-request contamination', async () => {
    const matcher = createRouteRenderMatcher(hybridRoutes, 'ssr')
    const urls = Object.keys(expectedHybrid)
    const results = await Promise.all(
      Array.from({ length: 240 }, (_, index) => {
        const url = urls[index % urls.length]
        return Promise.resolve(matcher.resolve(url)).then((mode) => [url, mode] as const)
      })
    )
    for (const [url, mode] of results) {
      expect(mode).toBe(expectedHybrid[url])
    }
  })

  it('classifies cross-render redirects by the destination route', () => {
    const matcher = createRouteRenderMatcher(hybridRoutes, 'ssr')
    expect(matcher.resolve('/go-app')).toBe('spa')
    expect(matcher.resolve('/app/go-public')).toBe('ssr')
    expect(matcher.resolve('/legacy')).toBe('ssr')
  })

  it('rejects redirect cycles while classifying a request', () => {
    const matcher = createRouteRenderMatcher(
      [
        { path: '/loop-a', redirect: '/loop-b' },
        { path: '/loop-b', redirect: '/loop-a' },
      ],
      'ssr'
    )
    expect(() => matcher.resolve('/loop-a')).toThrow(/Redirect cycle detected/)
  })

  it('does not navigate the shared router while classifying a request', () => {
    const matcher = createRouteRenderMatcher(hybridRoutes, 'ssr')
    expect(matcher.resolve('/app/projects')).toBe('spa')
    expect(matcher.resolve('/about')).toBe('ssr')
    expect(matcher.resolve('/admin/users')).toBe('spa')
  })

  it('excludes SPA branches from automatic sitemap discovery', () => {
    expect(discoverStaticSitemapPaths(hybridRoutes, 'ssr')).toEqual([
      '/',
      '/about',
      '/lazy',
      '/named',
    ])
  })
})
