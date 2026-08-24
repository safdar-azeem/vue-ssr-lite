import { describe, expect, it } from 'vitest'
import type { RouteRecordRaw } from 'vue-router'
import {
  discoverStaticSitemapPaths,
  mergeSitemapEntries,
  serializeSitemapXml,
} from './sitemap'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: {},
    children: [
      { path: '', component: {} },
      { path: 'about', component: {} },
      {
        path: 'docs',
        component: {},
        children: [{ path: 'getting-started', component: {} }],
      },
    ],
  },
  { path: '/login', redirect: '/' },
  { path: '/blog/:slug', component: {} },
  { path: '/:pathMatch(.*)*', component: {}, meta: { seo: { status: 404 } } },
  { path: '/dashboard', component: {}, meta: { seo: { index: false } } },
  { path: '/preview', component: {}, meta: { seo: { sitemap: false } } },
  { path: '/gone', component: {}, meta: { seo: { status: 410 } } },
]

describe('static sitemap discovery', () => {
  it('includes static nested routes and applies exclusion rules', () => {
    expect(discoverStaticSitemapPaths(routes)).toEqual([
      '/',
      '/about',
      '/docs',
      '/docs/getting-started',
    ])
  })

  it('does not treat sitemap:false as noindex input', () => {
    expect(discoverStaticSitemapPaths(routes)).not.toContain('/preview')
    expect(
      discoverStaticSitemapPaths([
        { path: '/preview', component: {}, meta: { seo: { sitemap: false } } },
      ])
    ).toEqual([])
  })

  it('serializes absolute locs and optional lastmod', () => {
    const xml = serializeSitemapXml(
      mergeSitemapEntries('https://ex.com', ['/'], [
        { loc: '/blog/one', lastmod: '2026-08-24' },
      ])
    )
    expect(xml).toContain('<loc>https://ex.com/</loc>')
    expect(xml).toContain('<loc>https://ex.com/blog/one</loc>')
    expect(xml).toContain('<lastmod>2026-08-24T00:00:00.000Z</lastmod>')
    expect(xml).not.toContain('priority')
    expect(xml).not.toContain('changefreq')
  })
})
