import { describe, expect, it } from 'vitest'
import { serializeJsonLd } from '../SsrManagedHead'
import {
  injectSsrHtml,
  prepareSsrHtmlTemplate,
} from './SsrHtmlRuntime'

describe('SSR HTML runtime', () => {
  it('scans long quoted attributes and raw-text elements without recognizing decoy mount elements', () => {
    const largeAttribute = 'large > quoted < text '.repeat(10_000)
    const source = `<html><head>
      <meta data-content="${largeAttribute}">
      <script>const example = '<div id="app"></div>'</script>
      <style>.example::after { content: '<div id="app"></div>' }</style>
      <title>Example &lt;div id="app"&gt;</title>
      </head><body><!-- <div id="app"></div> -->
      <textarea><div id="app"></div></textarea>
      <div data-id="app" aria-id="app"></div>
      <section data-text='quoted > end' ID = app></section></body></html>`
    const prepared = prepareSsrHtmlTemplate(source)
    expect(prepared).toContain(`<meta data-content="${largeAttribute}">`)
    expect(prepared).toContain("<section data-text='quoted > end' ID = app><!--vue-ssr-lite:html--></section>")
    expect(prepareSsrHtmlTemplate(prepared)).toBe(prepared)
  })

  it.each([
    '<div id="app" id="other"></div>',
    '<div id="other" ID = app></div>',
    '<div id="app" id></div>',
    '<div id="app"></div><aside id=app></aside>',
  ])('continues rejecting duplicate mount ids after native token scanning: %s', (mount) => {
    expect(() => prepareSsrHtmlTemplate(`<html><head></head><body>${mount}</body></html>`)).toThrow('appears more than once')
  })

  it('does not find a mount hidden by an unterminated quoted start tag', () => {
    expect(() => prepareSsrHtmlTemplate('<html><head></head><body><div title="unterminated ><div id=app></div></body></html>'))
      .toThrow('missing mount element')
  })

  it('prepares and injects head, teleports, markup, and inert state', () => {
    const template = prepareSsrHtmlTemplate(
      '<!doctype html><html><head><title>Fallback</title></head><body><div id="app"></div></body></html>'
    )
    const html = injectSsrHtml(template, {
      applicationId: 'public',
      html: '<main>Hello</main>',
      teleports: { body: '<div>Teleport</div>' },
      head: {
        tags: [
          {
            key: 'title',
            tag: 'title',
            attrs: {},
            textContent: '<Unsafe>',
          },
          {
            key: 'json-ld',
            tag: 'script',
            attrs: { type: 'application/ld+json' },
            textContent: serializeJsonLd([
              { value: '</script><script>alert(1)</script>' },
            ]),
          },
        ],
      },
      state: {
        version: 1,
        applicationId: 'public',
        publicConfig: {},
        domain: {
          entry: 'public',
          authority: 'public.test',
          protocol: 'https',
          port: '',
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

  it('preserves and deduplicates Vite CDN request assets', () => {
    const template = prepareSsrHtmlTemplate(
      '<html><head><link rel="stylesheet" href="https://cdn.example.com/app/page.css"></head><body><div id="app"></div></body></html>'
    )
    const html = injectSsrHtml(template, {
      applicationId: 'public',
      html: '<main>CDN</main>',
      teleports: {},
      head: { tags: [] },
      state: {
        version: 1,
        applicationId: 'public',
        publicConfig: {},
        domain: {
          entry: 'public',
          authority: 'public.test',
          protocol: 'https',
          port: '',
          hostname: 'public.test',
          baseDomain: 'public.test',
          subdomain: null,
          isCustomDomain: false,
          development: false,
          params: {},
        },
        application: {},
      },
      assets: [
        {
          applicationId: 'public',
          rel: 'stylesheet',
          href: 'https://cdn.example.com/app/page.css',
        },
        {
          applicationId: 'public',
          rel: 'modulepreload',
          href: 'https://cdn.example.com/app/page.js',
        },
      ],
    })
    expect(html.match(/cdn\.example\.com\/app\/page\.css/g)).toHaveLength(1)
    expect(html).toContain(
      '<link rel="modulepreload" href="https://cdn.example.com/app/page.js" crossorigin>'
    )
  })

  it('rejects templates without the declared mount element', () => {
    expect(() => prepareSsrHtmlTemplate('<html><head></head><body></body></html>'))
      .toThrow('missing mount element')
  })

  it('targets only an exact genuine mount id and preserves lookalike attributes', () => {
    const template = prepareSsrHtmlTemplate(
      `<html><head></head><body><section data-id="app"></section><aside aria-id='app'></aside><div class="shell" id='app'> \n </div></body></html>`
    )

    expect(template).toContain('<section data-id="app"></section>')
    expect(template).toContain("<aside aria-id='app'></aside>")
    expect(template).toContain(
      `<div class="shell" id='app'><!--vue-ssr-lite:html--></div>`
    )
  })

  it('rejects lookalike, case-mismatched, duplicate, and non-empty mounts', () => {
    expect(() =>
      prepareSsrHtmlTemplate(
        '<html><head></head><body><div data-id="app"></div><div aria-id="app"></div></body></html>'
      )
    ).toThrow('missing mount element #app')
    expect(() =>
      prepareSsrHtmlTemplate(
        '<html><head></head><body><div id="APP"></div></body></html>'
      )
    ).toThrow('missing mount element #app')
    expect(() =>
      prepareSsrHtmlTemplate(
        '<html><head></head><body><div id="app"></div><main id="app"></main></body></html>'
      )
    ).toThrow('appears more than once')
    expect(() =>
      prepareSsrHtmlTemplate(
        '<html><head></head><body><div id="app"><div>nested</div><p>surrounding</p></div></body></html>'
      )
    ).toThrow('must be an empty dedicated container')
  })

  it('merges declared HTML attributes without dropping template attributes', () => {
    const template = prepareSsrHtmlTemplate(
      '<html lang="de" data-shell="public"><head></head><body><div id="app"></div></body></html>'
    )
    const html = injectSsrHtml(template, {
      applicationId: 'public',
      html: '<main>Ready</main>',
      teleports: {},
      head: {
        tags: [],
        htmlAttributes: { lang: 'en', dir: 'ltr' },
      },
      state: {
        version: 1,
        applicationId: 'public',
        publicConfig: {},
        domain: {
          entry: 'public',
          authority: 'public.test',
          protocol: 'https',
          port: '',
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

    expect(html).toContain('lang="en"')
    expect(html).toContain('dir="ltr"')
    expect(html).toContain('data-shell="public"')
    expect(html).not.toContain('lang="de"')
  })

  it('injects every Vue Teleport target into its dedicated container', () => {
    const template = prepareSsrHtmlTemplate(
      '<html><head><meta name="theme-color" content="black"></head><body><div id="app"></div><div id="modals"></div><aside id="toasts"></aside></body></html>'
    )
    const state = {
      version: 1 as const,
      applicationId: 'public',
      publicConfig: {},
      domain: {
        entry: 'public',
        authority: 'localhost:4317',
        protocol: 'http' as const,
        port: '4317',
        hostname: 'localhost',
        baseDomain: 'localhost',
        subdomain: null,
        isCustomDomain: false,
        development: true,
        params: {},
      },
      application: {},
    }
    const html = injectSsrHtml(template, {
      applicationId: 'public',
      html: '<main>Application</main>',
      teleports: {
        '#modals': '<div>First modal</div><div>Second $& modal</div>',
        '#toasts': '<div>Toast</div>',
        body: '<div id="body-teleport">Body</div>',
      },
      head: { tags: [] },
      state,
    })

    expect(html).toContain(
      '<div id="modals"><div>First modal</div><div>Second $& modal</div></div>'
    )
    expect(html).toContain('<aside id="toasts"><div>Toast</div></aside>')
    expect(html).toContain('<body><div id="body-teleport">Body</div>')
    expect(html).toContain('<meta name="theme-color" content="black">')
  })

  it('rejects non-empty dedicated targets instead of corrupting nested HTML', () => {
    const template = prepareSsrHtmlTemplate(
      '<html><head></head><body><div id="app"></div><div id="modals"><div>existing</div></div></body></html>'
    )

    expect(() =>
      injectSsrHtml(template, {
        applicationId: 'public',
        html: '<main>Application</main>',
        teleports: { '#modals': '<div>Teleport</div>' },
        head: { tags: [] },
        state: {
          version: 1,
          applicationId: 'public',
          publicConfig: {},
          domain: {
            entry: 'public',
            authority: 'public.test',
            protocol: 'https',
            port: '',
            hostname: 'public.test',
            baseDomain: 'public.test',
            subdomain: null,
            isCustomDomain: false,
            development: false,
            params: {},
          },
          application: {},
        },
      })
    ).toThrow('must be an empty dedicated container')
  })

  it('rejects missing or unsafe Vue Teleport targets actionably', () => {
    const template = prepareSsrHtmlTemplate(
      '<html><head></head><body><div id="app"></div></body></html>'
    )
    const injection = {
      applicationId: 'public',
      html: '<main>Application</main>',
      head: { tags: [] },
      state: {
        version: 1 as const,
        applicationId: 'public',
        publicConfig: {},
        domain: {
          entry: 'public',
          authority: 'public.test',
          protocol: 'https' as const,
          port: '',
          hostname: 'public.test',
          baseDomain: 'public.test',
          subdomain: null,
          isCustomDomain: false,
          development: false,
          params: {},
        },
        application: {},
      },
    }

    expect(() =>
      injectSsrHtml(template, {
        ...injection,
        teleports: { '#missing': '<div>Missing</div>' },
      })
    ).toThrow('is missing from the SSR HTML template')
    expect(() =>
      injectSsrHtml(template, {
        ...injection,
        teleports: { '.modal': '<div>Unsafe</div>' },
      })
    ).toThrow('is unsupported by the SSR template injector')
  })

  it('uses exact genuine id attributes for Vue Teleport targets', () => {
    const source =
      '<html><head></head><body><div id="app"></div><div data-id="modals"></div><aside aria-id="modals"></aside><div class="target" id="modals"></div></body></html>'
    const template = prepareSsrHtmlTemplate(source)
    const injection = {
      applicationId: 'public',
      html: '<main>Application</main>',
      head: { tags: [] },
      state: {
        version: 1 as const,
        applicationId: 'public',
        publicConfig: {},
        domain: {
          entry: 'public',
          authority: 'public.test',
          protocol: 'https' as const,
          port: '',
          hostname: 'public.test',
          baseDomain: 'public.test',
          subdomain: null,
          isCustomDomain: false,
          development: false,
          params: {},
        },
        application: {},
      },
    }

    const html = injectSsrHtml(template, {
      ...injection,
      teleports: { '#modals': '<dialog>Exact</dialog>' },
    })
    expect(html).toContain('<div data-id="modals"></div>')
    expect(html).toContain('<aside aria-id="modals"></aside>')
    expect(html).toContain(
      '<div class="target" id="modals"><dialog>Exact</dialog></div>'
    )

    const lookalikeOnly = prepareSsrHtmlTemplate(
      '<html><head></head><body><div id="app"></div><div data-id="modals"></div></body></html>'
    )
    expect(() =>
      injectSsrHtml(lookalikeOnly, {
        ...injection,
        teleports: { '#modals': '<dialog>Missing</dialog>' },
      })
    ).toThrow('is missing from the SSR HTML template')

    const wrongCase = prepareSsrHtmlTemplate(
      '<html><head></head><body><div id="app"></div><div id="MODALS"></div></body></html>'
    )
    expect(() =>
      injectSsrHtml(wrongCase, {
        ...injection,
        teleports: { '#modals': '<dialog>Missing</dialog>' },
      })
    ).toThrow('is missing from the SSR HTML template')

    const duplicate = prepareSsrHtmlTemplate(
      '<html><head></head><body><div id="app"></div><div id="modals"></div><aside id="modals"></aside></body></html>'
    )
    expect(() =>
      injectSsrHtml(duplicate, {
        ...injection,
        teleports: { '#modals': '<dialog>Duplicate</dialog>' },
      })
    ).toThrow('Teleport target ids must be unique')

    expect(() =>
      injectSsrHtml(template, {
        ...injection,
        teleports: { '#app': '<dialog>Unsafe</dialog>' },
      })
    ).toThrow('cannot be the SSR application mount')
  })
})
