import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { RouterView } from 'vue-router'
import { defineExtension } from './core/extensions/defineExtension'
import { useSeo } from './extensions/seo/useSeo'
import { defineApplication } from './index'
import { serializeManagedHead } from './SsrManagedHead'
import { renderSsrApplication } from './SsrRenderRuntime'
import { setResponseStatus } from './SsrResponseStatus'
import { createTestRenderRequest } from './SsrTestFixtures'

const Shell = defineComponent({
  setup: () => () => h(RouterView),
})

const page = (setup: () => void, name = 'Page') =>
  defineComponent({
    name,
    setup() {
      setup()
      return () => h('main', name)
    },
  })

const request = (path: string, host = 'ex.test') =>
  createTestRenderRequest(host, {
    url: `https://${host}${path}`,
  })

describe('approved architecture acceptance', () => {
  it('renders useSeo tags during SSR without onMounted', async () => {
    const application = defineApplication({
      id: 'seo-ssr',
      root: Shell,
      routes: [
        {
          path: '/about',
          component: page(() => {
            useSeo({
              title: 'About',
              description: 'Learn about us.',
            })
          }, 'About'),
        },
      ],
      seo: {
        siteName: 'Demo',
        titleTemplate: '%s | Demo',
        siteUrl: 'https://ex.test',
      },
    })

    const rendered = await renderSsrApplication(application, request('/about'))
    const head = serializeManagedHead(rendered.head)
    expect(head).toContain('>About | Demo</title>')
    expect(head).toContain('name="description"')
    expect(head).toContain('Learn about us.')
    expect(head).toContain('rel="canonical"')
    expect(head).toContain('https://ex.test/about')
    expect(head).toContain('property="og:title"')
    expect(head).toContain('name="twitter:card"')
    expect(rendered.html).toContain('About')
  })

  it('isolates concurrent requests and extension state', async () => {
    const titled = defineApplication({
      id: 'iso-title',
      root: Shell,
      routes: [
        {
          path: '/a',
          component: page(() => useSeo({ title: 'Alpha' })),
        },
        {
          path: '/b',
          component: page(() => useSeo({ title: 'Beta' })),
        },
      ],
      seo: { siteUrl: 'https://ex.test' },
    })

    const [left, right] = await Promise.all([
      renderSsrApplication(titled, request('/a')),
      renderSsrApplication(titled, request('/b')),
    ])
    expect(left.head.title).toBe('Alpha')
    expect(right.head.title).toBe('Beta')
  })

  it('uses async setup data in the settled head', async () => {
    const application = defineApplication({
      id: 'async-seo',
      root: Shell,
      routes: [
        {
          path: '/article',
          component: defineComponent({
            async setup() {
              const title = ref('Loading')
              useSeo({
                title: () => title.value,
              })
              title.value = await Promise.resolve('Resolved article')
              return () => h('main', title.value)
            },
          }),
        },
      ],
      seo: { siteUrl: 'https://ex.test' },
    })
    const rendered = await renderSsrApplication(application, request('/article'))
    expect(rendered.head.title).toBe('Resolved article')
    expect(rendered.html).toContain('Resolved article')
  })

  it('applies route status, runtime override, and error noindex', async () => {
    const application = defineApplication({
      id: 'status',
      root: Shell,
      routes: [
        {
          path: '/missing',
          component: page(() => {
            useSeo({ index: true })
          }),
          meta: { seo: { status: 404, index: true } },
        },
        {
          path: '/lookup/:slug',
          component: page(() => {
            setResponseStatus(404)
            useSeo({ index: true, title: 'Missing article' })
          }),
          meta: { seo: { status: 200 } },
        },
      ],
      seo: { siteUrl: 'https://ex.test' },
    })

    const routed = await renderSsrApplication(application, request('/missing'))
    expect(routed.response.statusCode).toBe(404)
    expect(serializeManagedHead(routed.head)).toContain('noindex')

    const runtime = await renderSsrApplication(
      application,
      request('/lookup/none')
    )
    expect(runtime.response.statusCode).toBe(404)
    expect(serializeManagedHead(runtime.head)).toContain('noindex')
  })

  it('keeps HTTP status when SEO is disabled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const application = defineApplication({
      id: 'disabled',
      root: Shell,
      routes: [
        {
          path: '/gone',
          component: page(() => {
            useSeo({ title: 'Should not render' })
            setResponseStatus(404)
          }),
          meta: { seo: { status: 404 } },
        },
      ],
      seo: { enabled: false },
    })
    const rendered = await renderSsrApplication(application, request('/gone'))
    expect(rendered.response.statusCode).toBe(404)
    expect(serializeManagedHead(rendered.head)).not.toContain('Should not render')
    expect(serializeManagedHead(rendered.head)).not.toContain('canonical')
    expect(warn).toHaveBeenCalledWith(
      '[vue-ssr-lite] useSeo() was called, but the built-in SEO extension is disabled.'
    )
    warn.mockRestore()
  })

  it('keeps titles in private mode and omits canonical', async () => {
    const application = defineApplication({
      id: 'private',
      root: Shell,
      routes: [
        {
          path: '/',
          component: page(() => useSeo({ title: 'Dashboard' })),
        },
      ],
      seo: { mode: 'private', titleTemplate: '%s | Workspace' },
    })
    const rendered = await renderSsrApplication(application, request('/'))
    expect(rendered.head.title).toBe('Dashboard | Workspace')
    expect(serializeManagedHead(rendered.head)).not.toContain('rel="canonical"')
    expect(serializeManagedHead(rendered.head)).toContain('noindex, nofollow')
  })

  it('rejects invalid response statuses', async () => {
    const application = defineApplication({
      id: 'invalid-status',
      root: Shell,
      routes: [
        {
          path: '/',
          component: page(() => setResponseStatus(0 as number)),
        },
      ],
      seo: { enabled: false },
    })
    await expect(
      renderSsrApplication(application, request('/'))
    ).rejects.toThrow(/Invalid HTTP status/)
  })

  it('lets a later custom extension win the same head key', async () => {
    const custom = defineExtension({
      name: 'custom-title',
      setup(context) {
        context.contributeHead({ title: 'From extension' })
      },
    })
    const application = defineApplication({
      id: 'override',
      root: Shell,
      routes: [{ path: '/', component: page(() => useSeo({ title: 'Page' })) }],
      seo: { siteUrl: 'https://ex.test' },
      extensions: [custom],
    })
    const rendered = await renderSsrApplication(application, request('/'))
    expect(rendered.head.title).toBe('From extension')
  })

  it('escapes JSON-LD and does not trust a spoofed host for canonicals', async () => {
    const application = defineApplication({
      id: 'secure',
      root: Shell,
      routes: [
        {
          path: '/',
          component: page(() =>
            useSeo({
              title: 'Home',
              structuredData: {
                name: '</script><script>alert(1)</script>',
              },
            })
          ),
        },
      ],
      seo: { siteUrl: 'https://authoritative.test' },
    })
    const rendered = await renderSsrApplication(
      application,
      createTestRenderRequest('evil.test', {
        url: 'https://evil.test/',
        host: 'evil.test',
        siteOrigin: 'https://authoritative.test',
      })
    )
    const head = serializeManagedHead(rendered.head)
    expect(head).toContain('https://authoritative.test/')
    expect(head).not.toContain('https://evil.test/')
    expect(head).toContain('\\u003c/script\\u003e')
    expect(head).not.toContain('</script><script>alert(1)</script>')
    const jsonLd = head.match(
      /<script[^>]*data-vue-ssr-lite-head="json-ld"[^>]*>([\s\S]*?)<\/script>/
    )?.[1]
    expect(jsonLd).toBeTruthy()
    expect(jsonLd).not.toContain('</script>')
  })

  it('warns about setup misuse separately from SEO being disabled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    useSeo({ title: 'Nope' })
    expect(warn).toHaveBeenCalledWith(
      '[vue-ssr-lite] useSeo() must be called during component setup().'
    )
    expect(warn).not.toHaveBeenCalledWith(
      '[vue-ssr-lite] useSeo() was called, but the built-in SEO extension is disabled.'
    )
    warn.mockRestore()
  })
})

describe('architecture source boundaries', () => {
  it('does not import server-only SEO modules from universal entries', async () => {
    const { readFile } = await import('node:fs/promises')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = dirname(fileURLToPath(import.meta.url))
    const [indexSource, clientSource, seoIndex] = await Promise.all([
      readFile(join(root, 'index.ts'), 'utf8'),
      readFile(join(root, 'client.ts'), 'utf8'),
      readFile(join(root, 'extensions/seo/index.ts'), 'utf8'),
    ])
    for (const source of [indexSource, clientSource, seoIndex]) {
      expect(source).not.toMatch(/seo\/sitemap/)
      expect(source).not.toMatch(/SeoEndpoints/)
      expect(source).not.toMatch(/SsrSitemapConfig/)
      expect(source).not.toMatch(/SsrSiteOriginRuntime/)
      expect(source).not.toMatch(/node:fs/)
    }
  })
})
