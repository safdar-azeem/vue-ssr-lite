import { describe, expect, it } from 'vitest'
import {
  injectSsrHtml,
  prepareSsrHtmlTemplate,
} from './SsrHtmlRuntime'

describe('SSR HTML runtime', () => {
  it('prepares and injects head, teleports, markup, and inert state', () => {
    const template = prepareSsrHtmlTemplate(
      '<!doctype html><html><head><title>Fallback</title></head><body><div id="app"></div></body></html>'
    )
    const html = injectSsrHtml(template, {
      applicationId: 'public',
      html: '<main>Hello</main>',
      teleports: '<div>Teleport</div>',
      head: {
        title: '<Unsafe>',
        jsonLd: [{ value: '</script><script>alert(1)</script>' }],
      },
      state: {
        version: 1,
        applicationId: 'public',
        publicConfig: {},
        domain: {
          entry: 'public',
          hostname: 'public.test',
          baseDomain: 'public.test',
          subdomain: null,
          isCustomDomain: false,
          development: true,
          params: {},
        },
        application: { value: '</script><script>alert(1)</script>' },
      },
    })

    expect(html).toContain('&lt;Unsafe&gt;')
    expect(html).not.toContain('Fallback')
    expect(html).toContain('<main>Hello</main>')
    expect(html).toContain('type="application/json"')
    expect(html).toContain('\\u003c/script>')
    expect(html).not.toContain('</script><script>alert(1)</script>')
  })

  it('rejects templates without the declared mount element', () => {
    expect(() => prepareSsrHtmlTemplate('<html><head></head><body></body></html>'))
      .toThrow('missing mount element')
  })

  it('merges declared HTML attributes without dropping template attributes', () => {
    const template = prepareSsrHtmlTemplate(
      '<html lang="en" data-shell="public"><head></head><body><div id="app"></div></body></html>'
    )
    const html = injectSsrHtml(template, {
      applicationId: 'public',
      html: '<main>Ready</main>',
      teleports: '',
      head: { htmlAttributes: { lang: 'ur', dir: 'rtl' } },
      state: {
        version: 1,
        applicationId: 'public',
        publicConfig: {},
        domain: {
          entry: 'public',
          hostname: 'public.test',
          baseDomain: 'public.test',
          subdomain: null,
          isCustomDomain: false,
          development: true,
          params: {},
        },
        application: {},
      },
    })

    expect(html).toContain('lang="ur"')
    expect(html).toContain('dir="rtl"')
    expect(html).toContain('data-shell="public"')
    expect(html).not.toContain('lang="en"')
  })
})
