import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computed, defineComponent, h, ref } from 'vue'
import { RouterView } from 'vue-router'
import { describe, expect, it, vi } from 'vitest'
import { createSeoEndpoints } from './SeoEndpoints'
import { normalizeSeo, validateSeoApplicationConfig, validateSeoSiteDefaults } from './normalize'
import { serializeRobotsConfig } from './robots'
import {
  mergeSeoInput,
  mergeSeoLayers,
  registerSeoLayer,
  createSeoState,
} from './state'
import {
  collectSitemapSource,
  mergeSitemapEntries,
  serializeSitemapIndexXml,
  serializeSitemapXml,
} from './sitemap'
import { renderSsrApplication } from '../../SsrRenderRuntime'
import { serializeManagedHead } from '../../SsrManagedHead'
import { createTestDomain, createTestRenderRequest } from '../../SsrTestFixtures'
import { setResponseRedirect } from '../../SsrResponseStatus'
import { useSeo } from './useSeo'
import { resolveServerSiteOrigin } from '../../server/SsrSiteOriginRuntime'
import type { SsrHttpRequest } from '../../SsrRuntimeTypes'

const request = (pathname: string, host = 'tenant.test'): SsrHttpRequest<any> => ({
  ...createTestRenderRequest(host, {
    url: `https://${host}${pathname}`,
    siteOrigin: `https://${host}`,
    domain: createTestDomain(host, { isCustomDomain: true }),
  }),
  pathname,
  search: '',
  entryId: 'website',
})

describe('SEO 1.0 composition and validation', () => {
  it('composes application, site, parent, child, and component layers field-by-field', () => {
    const organization = { '@id': 'https://tenant.test/#org', '@type': 'Organization', name: 'Platform' }
    const state = createSeoState(
      {
        title: 'Platform',
        description: 'Platform description',
        openGraph: { localeAlternate: ['en'], image: [{ key: 'hero', url: '/platform.png' }] },
        structuredData: organization,
        meta: [{ key: 'theme', name: 'theme-color', content: '#fff' }],
      },
      {
        title: null,
        siteName: 'Tenant',
        openGraph: { localeAlternate: ['fr'], image: [{ key: 'hero', url: '/tenant.png' }] },
        structuredData: { ...organization, name: 'Tenant' },
      }
    )
    registerSeoLayer(state, {
      title: 'Component',
      alternates: { languages: { fr: null, 'x-default': '/' } },
      structuredData: { '@type': 'Product', name: 'Widget' },
      meta: [{ key: 'theme', name: 'theme-color', content: '#000' }],
    })
    const route = {
      matched: [
        { meta: { seo: { description: 'Parent', alternates: { languages: { en: '/en', fr: '/fr' } } } } },
        { meta: { seo: { description: 'Child' } } },
      ],
    } as any
    const resolved = mergeSeoLayers(state, route)
    expect(resolved.title).toBe('Component')
    expect(resolved.description).toBe('Child')
    expect(resolved.siteName).toBe('Tenant')
    expect(resolved.alternates?.languages).toEqual({ en: '/en', 'x-default': '/' })
    expect((resolved.openGraph?.image as any[]).map((image) => image.url)).toEqual(['/tenant.png'])
    expect(resolved.openGraph?.localeAlternate).toEqual(['en', 'fr'])
    expect(resolved.meta).toEqual([{ key: 'theme', name: 'theme-color', content: '#000' }])
    expect(resolved.structuredData).toEqual([
      { ...organization, name: 'Tenant' },
      { '@type': 'Product', name: 'Widget' },
    ])
  })

  it('supports collection clearing, nested clearing, and structured-data replacement', () => {
    const base = {
      openGraph: { title: 'Inherited' },
      twitter: { title: 'Inherited' },
      robots: { noarchive: true },
      meta: [{ name: 'author', content: 'A' }],
      links: [{ rel: 'alternate', href: '/feed.xml', type: 'application/rss+xml' }],
      structuredData: [{ '@type': 'Organization' }],
    }
    const cleared = mergeSeoInput(base, {
      openGraph: null,
      twitter: null,
      robots: null,
      meta: null,
      links: null,
      structuredData: [{ '@type': 'Article' }],
      structuredDataMode: 'replace',
    })
    expect(cleared.openGraph).toBeNull()
    expect(cleared.twitter).toBeNull()
    expect(cleared.robots).toBeNull()
    expect(cleared.meta).toBeNull()
    expect(cleared.links).toBeNull()
    expect(cleared.structuredData).toEqual([{ '@type': 'Article' }])
  })

  it('rejects global/site ownership violations and reserved robots directives', () => {
    expect(() => validateSeoApplicationConfig({ canonical: '/wrong' } as any)).toThrow(/page\/route-owned/)
    expect(() => validateSeoApplicationConfig({ openGraph: { url: '/wrong' } } as any)).toThrow(/page-owned url/)
    expect(() => validateSeoSiteDefaults({
      links: [{ rel: 'ALTERNATE', hreflang: 'en', href: '/en' }],
    })).toThrow(/hreflang/)
    expect(() => validateSeoApplicationConfig({
      robots: { additional: { max_snippet: 12 } },
    })).toThrow(/reserved/)
    expect(() => validateSeoApplicationConfig({
      meta: [{ property: 'OG:URL', content: 'https://evil.test' }],
    })).toThrow(/og:url/)
    expect(() => validateSeoApplicationConfig({
      links: [{ rel: 'alternate', href: '/feed.xml' }],
    })).not.toThrow()
  })

  it('distinguishes canonical omission, false, null, explicit values, and errors for og:url', () => {
    const options = { config: {}, origin: 'https://tenant.test', path: '/page', status: 200 }
    const automatic = normalizeSeo({ ...options, input: {} })
    expect(automatic.canonical).toBe('https://tenant.test/page')
    expect(automatic.openGraph.url).toBe('https://tenant.test/page')
    for (const canonical of [false, null] as const) {
      const suppressed = normalizeSeo({ ...options, input: { canonical } })
      expect(suppressed.canonical).toBeNull()
      expect(suppressed.openGraph.url).toBeUndefined()
    }
    const explicit = normalizeSeo({
      ...options,
      input: { canonical: '/canonical', openGraph: { url: '/social' } },
    })
    expect(explicit.canonical).toBe('https://tenant.test/canonical')
    expect(explicit.openGraph.url).toBe('https://tenant.test/social')
    const error = normalizeSeo({ ...options, status: 404, input: { structuredData: { '@type': 'Article' } } })
    expect(error.canonical).toBeNull()
    expect(error.openGraph.url).toBeUndefined()
    expect(error.structuredData).toEqual([])
    expect(error.robots).toContain('noindex')
    expect(error.robots).toContain('follow')
  })

  it('rejects unsafe page URLs and control-character directives', () => {
    expect(() => normalizeSeo({
      config: {}, input: { canonical: 'javascript:alert(1)' }, origin: 'https://tenant.test', path: '/', status: 200,
    })).toThrow(/http or https/)
    expect(() => normalizeSeo({
      config: {}, input: { canonical: 'https://other.test/' }, origin: 'https://tenant.test', path: '/', status: 200,
    })).toThrow(/same-origin/)
    expect(() => validateSeoApplicationConfig({
      robots: { additional: { future: 'yes\r\nDisallow: /' } },
    })).toThrow(/control/)
  })

  it('does not let generic page hatches defeat mandatory error SEO', () => {
    const error = normalizeSeo({
      config: {},
      input: {
        meta: [
          { name: 'robots', content: 'index, nofollow' },
          { property: 'og:url', content: '/wrong' },
        ],
        links: [
          { rel: 'canonical', href: '/wrong' },
          { rel: 'alternate', hreflang: 'en', href: '/en/wrong' },
        ],
      },
      origin: 'https://tenant.test', path: '/missing', status: 404,
    })
    expect(error.robots).toBe('noindex, follow')
    expect(error.meta).toEqual([])
    expect(error.links).toEqual([])
  })
})

describe('SEO 1.0 Core status, redirects, and hydration snapshot', () => {
  const Shell = defineComponent({ setup: () => () => h(RouterView) })

  it('supports whole-object computed SEO and scoped declarative status during SSR', async () => {
    const missing = ref(true)
    const application = {
      id: 'whole-object',
      root: Shell,
      routes: [{
        path: '/article',
        component: defineComponent({
          setup() {
            useSeo(computed(() => missing.value
              ? { title: 'Missing', status: 404 }
              : { title: 'Article', status: 200 }))
            return () => h('main', 'article')
          },
        }),
      }],
      seo: { siteUrl: 'https://tenant.test' },
    }
    const rendered = await renderSsrApplication(application, request('/article'))
    expect(rendered.response.statusCode).toBe(404)
    expect(rendered.head.title).toBe('Missing')
    expect(serializeManagedHead(rendered.head)).toContain('noindex')
  })

  it('records validated redirects and suppresses normal indexable head output', async () => {
    const application = {
      id: 'redirect',
      root: defineComponent({
        setup() {
          setResponseRedirect('/target', { status: 308 })
          useSeo({ title: 'Old', structuredData: { '@type': 'Article' } })
          return () => h('main', 'old')
        },
      }),
      seo: { siteUrl: 'https://tenant.test' },
    }
    const rendered = await renderSsrApplication(application, request('/old'))
    expect(rendered.response.redirect).toEqual({
      location: 'https://tenant.test/target', statusCode: 308, allowExternal: false,
    })
    const head = serializeManagedHead(rendered.head)
    expect(head).not.toContain('rel="canonical"')
    expect(head).not.toContain('application/ld+json')
  })

  it('rejects external, credentialed, and control-character redirects by default', async () => {
    const renderRedirect = (location: string, allowExternal = false) => renderSsrApplication({
      id: `bad-redirect-${location.length}`,
      root: defineComponent({
        setup() {
          setResponseRedirect(location, { allowExternal })
          return () => h('main')
        },
      }),
    }, request('/old'))
    await expect(renderRedirect('https://other.test/path')).rejects.toThrow(/Cross-origin/)
    await expect(renderRedirect('https://user:pass@other.test/path', true)).rejects.toThrow(/credentials/)
    await expect(renderRedirect('/safe\r\nLocation: https://evil.test')).rejects.toThrow(/control/)
  })

  it('hydrates only the public site defaults and excludes provider hints', async () => {
    const rendered = await renderSsrApplication(
      { id: 'site-snapshot', root: defineComponent(() => () => h('main')), seo: { title: 'Platform' } },
      createTestRenderRequest('tenant.test', {
        siteOrigin: 'https://tenant.test',
        siteSeo: { title: 'Tenant', siteName: 'Tenant name' },
        siteSeoMeta: { revision: 'secret-revision', cacheTags: ['tenant:1'] },
      })
    )
    expect(rendered.head.title).toBe('Tenant')
    expect(rendered.hydrationState.siteSeo).toEqual({ title: 'Tenant', siteName: 'Tenant name' })
    expect(JSON.stringify(rendered.hydrationState)).not.toContain('secret-revision')
    expect(JSON.stringify(rendered.hydrationState)).not.toContain('tenant:1')
  })

  it('isolates concurrent tenant snapshots at the same pathname', async () => {
    const application = {
      id: 'tenant-isolation',
      root: defineComponent({ setup: () => () => h('main', 'tenant') }),
      seo: { title: 'Platform' },
    }
    const [tenantA, tenantB] = await Promise.all([
      renderSsrApplication(application, createTestRenderRequest('a.example', {
        url: 'https://a.example/page', siteOrigin: 'https://a.example', siteSeo: { title: 'Tenant A' },
      })),
      renderSsrApplication(application, createTestRenderRequest('b.example', {
        url: 'https://b.example/page', siteOrigin: 'https://b.example', siteSeo: { title: 'Tenant B' },
      })),
    ])
    expect(tenantA.head.title).toBe('Tenant A')
    expect(tenantB.head.title).toBe('Tenant B')
    expect(serializeManagedHead(tenantA.head)).toContain('https://a.example/page')
    expect(serializeManagedHead(tenantB.head)).toContain('https://b.example/page')
  })
})

describe('SEO 1.0 robots, sitemap, endpoints, and origin authority', () => {
  it('serializes multiple robots groups and rejects mixed/reserved/injected fields', () => {
    const body = serializeRobotsConfig({
      groups: [
        { userAgents: ['Googlebot', 'Bingbot'], allow: ['/'], disallow: ['/admin'] },
        { userAgents: '*', directives: { CrawlDelay: 2 } },
      ],
      sitemaps: ['https://tenant.test/sitemap.xml'],
    })
    expect(body).toContain('User-agent: Googlebot')
    expect(body).toContain('User-agent: Bingbot')
    expect(body).toContain('CrawlDelay: 2')
    expect(() => serializeRobotsConfig({ groups: [], allow: ['/'] } as any)).toThrow(/mixed/)
    expect(() => serializeRobotsConfig({
      groups: [{ userAgents: '*', directives: { allow: '/private' } }],
    })).toThrow(/reserved/)
    expect(() => serializeRobotsConfig({ disallow: ['/\r\nAllow: /'] })).toThrow(/invalid/)
  })

  it('serializes hreflang, image, video, and news extensions and validates limits', () => {
    const entries = mergeSitemapEntries('https://tenant.test', [], [{
      loc: '/article',
      lastmod: '2026-08-26',
      changefreq: 'daily',
      priority: 0.8,
      alternates: { en: '/en/article', 'x-default': '/article' },
      images: [{ loc: 'https://cdn.test/image.jpg' }],
      videos: [{
        thumbnailLoc: 'https://cdn.test/thumb.jpg', title: 'Video', description: 'Description',
        playerLoc: 'https://video.test/player', duration: 60, tags: ['one'],
      }],
      news: {
        publication: { name: 'Daily', language: 'en' }, publicationDate: '2026-08-26', title: 'News',
      },
    }])
    const xml = serializeSitemapXml(entries)
    expect(xml).toContain('<xhtml:link')
    expect(xml).toContain('<image:image>')
    expect(xml).toContain('<video:video>')
    expect(xml).toContain('<news:news>')
    expect(() => mergeSitemapEntries('https://tenant.test', [], [{
      loc: '/bad', videos: [{ thumbnailLoc: '/t', title: 'Bad', description: 'x' }],
    }])).toThrow(/contentLoc or playerLoc/)
    expect(() => mergeSitemapEntries('https://tenant.test', [], [{
      loc: '/bad', images: Array.from({ length: 1001 }, () => ({ loc: '/image' })),
    }])).toThrow(/1,000 images/)
  })

  it('uses deterministic 1-based sitemap index paths', () => {
    const xml = serializeSitemapIndexXml('https://tenant.test', 2)
    expect(xml).toContain('https://tenant.test/sitemap-1.xml')
    expect(xml).toContain('https://tenant.test/sitemap-2.xml')
  })

  it('enforces URL/news file limits and observes provider cancellation', async () => {
    expect(() => serializeSitemapXml(
      Array.from({ length: 50_001 }, (_, index) => ({ loc: `https://tenant.test/${index}` }))
    )).toThrow(/50,000 URLs/)
    const newsEntries = Array.from({ length: 1001 }, (_, index) => ({
      loc: `https://tenant.test/news/${index}`,
      news: {
        publication: { name: 'Daily', language: 'en' },
        publicationDate: '2026-08-26T00:00:00.000Z',
        title: `News ${index}`,
      },
    }))
    expect(() => serializeSitemapXml(newsEntries)).toThrow(/1,000 news/)
    const controller = new AbortController()
    controller.abort(new DOMException('Cancelled', 'AbortError'))
    await expect(collectSitemapSource([{ loc: '/' }], 'https://tenant.test', controller.signal))
      .rejects.toThrow(/Cancelled/)
  })

  it('gates endpoints with siteSeo not-found and skips tenant providers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-seo-'))
    const sitemapProvider = vi.fn(() => [{ loc: '/' }])
    const siteRobots = { resolve: vi.fn(() => ({ status: 'resolved' as const, config: {} })) }
    const endpoints = await createSeoEndpoints({
      applicationId: 'website', root, existingEndpoints: [], seo: {}, sitemapProvider, siteRobots,
      siteSeo: { resolve: async (context) => {
        expect(context).not.toHaveProperty('pathname')
        expect(context).not.toHaveProperty('search')
        expect(context).not.toHaveProperty('publicConfig')
        return { status: 'not-found', responseStatus: 421 }
      } },
      resolveSiteUrl: async () => 'https://tenant.test',
    })
    const sitemap = endpoints.find((endpoint) => endpoint.match(request('/sitemap.xml')))!
    const result = await sitemap.handle(request('/sitemap.xml'), { signal: request('/').signal })
    expect(result?.statusCode).toBe(421)
    expect(result?.body).toBeUndefined()
    expect(sitemapProvider).not.toHaveBeenCalled()
    expect(siteRobots.resolve).not.toHaveBeenCalled()
  })

  it('serves shard 1 with validators without materializing other shards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-shards-'))
    const getShard = vi.fn((_context, shard: number) => [{ loc: `/page-${shard}` }])
    const endpoints = await createSeoEndpoints({
      applicationId: 'website', root, existingEndpoints: [], seo: {},
      sitemapProvider: async () => ({ kind: 'sharded', revision: 'r1', shardCount: 2, getShard }),
      resolveSiteUrl: async () => 'https://tenant.test',
    })
    const endpoint = endpoints.find((entry) => entry.match(request('/sitemap-1.xml')))!
    const first = await endpoint.handle(request('/sitemap-1.xml'), { signal: request('/').signal })
    expect(first?.statusCode).toBe(200)
    expect(first?.body).toContain('https://tenant.test/page-1')
    expect(getShard).toHaveBeenCalledTimes(1)
    expect(getShard.mock.calls[0][1]).toBe(1)
    const conditionalRequest = request('/sitemap-1.xml')
    conditionalRequest.headers = { 'if-none-match': first?.headers?.etag }
    const conditional = await endpoint.handle(conditionalRequest, { signal: conditionalRequest.signal })
    expect(conditional?.statusCode).toBe(304)
    expect(getShard).toHaveBeenCalledTimes(1)
  })

  it('serves lazy sharded sitemaps without inventing cache validators', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-shards-'))
    const getShard = vi.fn((_context, shard: number) => [{ loc: `/page-${shard}` }])
    const endpoints = await createSeoEndpoints({
      applicationId: 'website', root, existingEndpoints: [], seo: {},
      sitemapProvider: async () => ({
        kind: 'sharded',
        shardCount: 2,
        cacheControl: 'no-store',
        getShard,
      }),
      resolveSiteUrl: async () => 'https://tenant.test',
    })
    const endpoint = endpoints.find((entry) => entry.match(request('/sitemap-1.xml')))!
    const staleValidatorRequest = {
      ...request('/sitemap-1.xml'),
      headers: { 'if-none-match': '"stale"' },
    }
    const response = await endpoint.handle(staleValidatorRequest, {
      signal: staleValidatorRequest.signal,
    })

    expect(response?.statusCode).toBe(200)
    expect(response?.headers.etag).toBeUndefined()
    expect(response?.headers['cache-control']).toBe('no-store')
    expect(response?.body).toContain('https://tenant.test/page-1')
    expect(getShard).toHaveBeenCalledTimes(1)
  })

  it('preserves legacy array sitemap providers as entry sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-arrays-'))
    const endpoints = await createSeoEndpoints({
      applicationId: 'website', root, existingEndpoints: [], seo: {},
      sitemapProvider: async () => [{ loc: '/dynamic' }],
      resolveSiteUrl: async () => 'https://tenant.test',
    })
    const endpoint = endpoints.find((entry) => entry.match(request('/sitemap.xml')))!
    const result = await endpoint.handle(request('/sitemap.xml'), { signal: request('/').signal })
    expect(result?.statusCode).toBe(200)
    expect(result?.body).toContain('https://tenant.test/dynamic')
  })

  it('private mode skips siteRobots and emits a conservative policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-private-'))
    const resolver = vi.fn()
    const endpoints = await createSeoEndpoints({
      applicationId: 'website', root, existingEndpoints: [], seo: { mode: 'private' },
      siteRobots: { resolve: resolver }, resolveSiteUrl: async () => 'https://tenant.test',
    })
    expect(endpoints.some((entry) => entry.match(request('/sitemap.xml')))).toBe(false)
    const robots = endpoints.find((entry) => entry.match(request('/robots.txt')))!
    const result = await robots.handle(request('/robots.txt'), { signal: request('/').signal })
    expect(result?.body).toContain('Disallow: /')
    expect(resolver).not.toHaveBeenCalled()
  })

  it('skips built-in SEO endpoints when a consumer already owns those paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-owned-seo-'))
    const endpoints = await createSeoEndpoints({
      applicationId: 'erp',
      root,
      existingEndpoints: [
        {
          id: 'erp-seo-boundary',
          ownedPaths: ['/robots.txt', '/sitemap.xml'],
          match: ({ entryId, pathname }) =>
            entryId === 'erp' &&
            (pathname === '/robots.txt' || pathname.startsWith('/sitemap')),
          handle: () => ({ statusCode: 404 }),
        },
      ],
      seo: {},
      resolveSiteUrl: async () => 'https://admin.test',
    })
    expect(endpoints.some((entry) => entry.id === 'erp-sitemap')).toBe(false)
    expect(endpoints.some((entry) => entry.id === 'erp-robots')).toBe(false)
  })

  it('does not execute consumer endpoint predicates while compiling SEO endpoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-owned-seo-pure-'))
    const match = vi.fn(() => true)
    const endpoints = await createSeoEndpoints({
      applicationId: 'website', root, seo: {},
      existingEndpoints: [{
        id: 'custom-sitemap',
        ownedPaths: ['/sitemap.xml'],
        match,
        handle: () => ({ statusCode: 200 }),
      }],
      resolveSiteUrl: async () => 'https://tenant.test',
    })
    expect(match).not.toHaveBeenCalled()
    expect(endpoints.some((entry) => entry.id === 'website-sitemap')).toBe(false)
  })

  it('applies dynamic robots validators without exposing publicConfig to the resolver', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-robots-meta-'))
    const resolver = vi.fn((context: any) => {
      expect(context).not.toHaveProperty('publicConfig')
      expect(context.pathname).toBe('/robots.txt')
      return {
        status: 'resolved' as const,
        config: {
          groups: [{ userAgents: '*', allow: ['/'] }],
          sitemaps: [`${context.siteOrigin}/sitemap.xml`],
        },
        revision: 'robots-r1',
        lastModified: '2026-08-26T00:00:00.000Z',
        cacheControl: 'public, max-age=120',
      }
    })
    const endpoints = await createSeoEndpoints({
      applicationId: 'website', root, existingEndpoints: [], seo: {},
      siteRobots: { resolve: resolver }, resolveSiteUrl: async () => 'https://tenant.test',
    })
    const endpoint = endpoints.find((entry) => entry.match(request('/robots.txt')))!
    const firstRequest = request('/robots.txt')
    firstRequest.publicConfig = { secretVariation: 'must not be observed' }
    const first = await endpoint.handle(firstRequest, { signal: firstRequest.signal })
    expect(first?.statusCode).toBe(200)
    expect(first?.headers?.etag).toBeTruthy()
    expect(first?.headers?.['last-modified']).toBeTruthy()
    expect(first?.headers?.['cache-control']).toBe('public, max-age=120')
    const secondRequest = request('/robots.txt')
    secondRequest.headers = { 'if-none-match': first?.headers?.etag }
    const second = await endpoint.handle(secondRequest, { signal: secondRequest.signal })
    expect(second?.statusCode).toBe(304)
    expect(second?.body).toBeUndefined()
  })

  it('makes resolveSiteUrl authoritative over seo.siteUrl and PUBLIC_URL', async () => {
    const req = request('/')
    const origin = await resolveServerSiteOrigin({
      request: req,
      siteUrl: 'https://static.test',
      publicUrl: 'https://public.test',
      resolveSiteUrl: async () => 'https://tenant.test',
      production: true,
      requireProductionOrigin: true,
    })
    expect(origin).toBe('https://tenant.test')
    await expect(resolveServerSiteOrigin({
      request: req,
      siteUrl: 'https://static.test',
      publicUrl: 'https://public.test',
      production: true,
      requireProductionOrigin: true,
    })).resolves.toBe('https://static.test')
    await expect(resolveServerSiteOrigin({
      request: req,
      publicUrl: 'https://public.test',
      production: true,
      requireProductionOrigin: true,
    })).resolves.toBe('https://public.test')
    await expect(resolveServerSiteOrigin({
      request: req,
      siteUrl: 'https://static.test',
      publicUrl: 'https://public.test',
      resolveSiteUrl: async () => undefined,
      production: true,
      requireProductionOrigin: true,
    })).resolves.toBe('https://static.test')
    await expect(resolveServerSiteOrigin({
      request: req,
      publicUrl: 'https://public.test',
      resolveSiteUrl: async () => '   ',
      production: true,
      requireProductionOrigin: true,
    })).resolves.toBe('https://public.test')
    await expect(resolveServerSiteOrigin({
      request: req,
      resolveSiteUrl: async () => undefined,
      production: true,
      requireProductionOrigin: true,
    })).resolves.toBe('https://tenant.test')
  })
})
