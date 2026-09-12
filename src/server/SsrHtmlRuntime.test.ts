import { describe, expect, it } from 'vitest'
import { serializeJsonLd } from '../SsrManagedHead'
import { createTestDomain } from '../SsrTestFixtures'
import {
  createSsrDevelopmentOpenInEditorHref,
  injectSsrHtml,
  prepareSsrHtmlTemplate,
  renderSsrErrorDocument,
  renderSsrPublicErrorDocument,
  resolveSsrPublicErrorPresentation,
} from './SsrHtmlRuntime'

describe('SSR HTML runtime', () => {
  it.each([
    { existing: '/assets/page.css?v=1', rendered: '/assets/page.css?v=2', temporary: false, count: 2 },
    { existing: '/assets/page.css?v=1', rendered: '/assets/page.css?v=1', temporary: false, count: 1 },
    { existing: '/assets/page.css?a=1&b=2', rendered: '/assets/page.css?b=2&a=1', temporary: false, count: 2 },
    { existing: '/src/Page.vue?vue&type=style&t=1', rendered: '/src/Page.vue?vue&type=style&direct&t=2', temporary: true, count: 1 },
  ])('deduplicates assets using the correct query identity: $rendered', ({ existing, rendered, temporary, count }) => {
    const template = prepareSsrHtmlTemplate(`<html><head><link rel="stylesheet" href="${existing}"></head><body><div id="app"></div></body></html>`)
    const asset = { applicationId: 'app', rel: 'stylesheet' as const, href: rendered, temporary }
    const html = injectSsrHtml(template, {
      applicationId: 'app', html: '', teleports: {}, head: null,
      state: { version: 1, applicationId: 'app', publicConfig: {}, application: {}, domain: createTestDomain('assets.test') },
      assets: [asset, asset],
    })
    expect(html.match(/rel="stylesheet"/g)).toHaveLength(count)
  })

  it('does not preload a module twice when Vite already emitted its entry script', () => {
    const template = prepareSsrHtmlTemplate('<html><head><script type="module" src="/assets/entry.js"></script></head><body><div id="app"></div></body></html>')
    const html = injectSsrHtml(template, {
      applicationId: 'app', html: '', teleports: {}, head: null,
      state: { version: 1, applicationId: 'app', publicConfig: {}, application: {}, domain: createTestDomain('assets.test') },
      assets: [{ applicationId: 'app', rel: 'modulepreload', href: '/assets/entry.js' }],
    })
    expect(html).not.toContain('rel="modulepreload"')
  })

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

describe('SSR error documents', () => {
  const errorId = 'vssl_8f3c2a7e1b0d4c56'

  it.each([
    [400, 'Bad Request', 'Invalid request', 'The request could not be processed.'],
    [421, 'Misdirected Request', 'Host not available', 'This host is not available.'],
    [500, 'Internal Server Error', 'Something went wrong', 'The request could not be completed.'],
    [503, 'Service Unavailable', 'Service unavailable', 'The service is temporarily unavailable. Please try again later.'],
    [504, 'Gateway Timeout', 'Request timed out', 'The server took too long to respond. Please try again.'],
  ] as const)('resolves the canonical %s public presentation', (
    statusCode,
    statusText,
    heading,
    description
  ) => {
    expect(resolveSsrPublicErrorPresentation(statusCode)).toEqual({
      statusCode,
      statusText,
      heading,
      description,
    })
  })

  it('renders a dark status-aware production page with an error id and no exception details', () => {
    const html = renderSsrPublicErrorDocument(500, { errorId })
    expect(html).toContain('noindex,nofollow')
    expect(html).toContain('background:#000')
    expect(html).toContain('<p class="status">500 · Internal Server Error</p>')
    expect(html).toContain('<h1>Something went wrong</h1>')
    expect(html).toContain('The request could not be completed.')
    expect(html).toContain(`Error ID: ${errorId}`)
    expect(html).toContain('id="main-content"')
    expect(html).not.toContain('TypeError')
    expect(html).not.toContain('Cannot read')
    expect(html).not.toContain('vite:vue')
    expect(html).not.toContain('HomeHero.vue')
    expect(html).not.toContain('vscode:')
    expect(html).not.toContain('__open-in-editor')
    expect(html).not.toContain('data-ssr-open-source')
    expect(html).not.toContain('Show details')
    expect(html).not.toContain('<details')
    expect(html).not.toContain('Request:')
    expect(html).not.toContain('Return home')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('<script')
  })

  it('omits the error id when it is unavailable', () => {
    const html = renderSsrPublicErrorDocument(503)
    expect(html).toContain('<div class="meta"></div>')
    expect(html).not.toContain('Error ID:')
  })

  it('does not render malformed correlation metadata', () => {
    const html = renderSsrPublicErrorDocument(500, {
      errorId: 'vssl_<script>alert(1)</script>',
    })
    expect(html).not.toContain('Error ID:')
    expect(html).not.toContain('alert(1)')
  })

  it('renders a dark development document with the message as the primary heading', () => {
    const html = renderSsrErrorDocument('Application error', 'fallback', {
      errorId,
      development: {
        name: 'TypeError',
        message: '<script>alert(1)</script>',
        stack: 'TypeError: <script>alert(1)</script>\n    at render (/app/Page.vue:1:1)',
        requestPathname: '/about/<img>',
      },
    })
    expect(html).toContain('background:#000')
    expect(html).toContain('.eyebrow{margin:0 0 0.6rem')
    expect(html).toContain('color:#ff0000')
    expect(html).toContain('h1{margin:0 0 1rem')
    expect(html).toContain('<p class="eyebrow">Application error</p>')
    expect(html).toContain('<h1>&lt;script&gt;alert(1)&lt;/script&gt;</h1>')
    expect(html).toContain('<p class="pill">TypeError</p>')
    expect(html).toContain('<details>')
    expect(html).not.toContain('<details open')
    expect(html).toContain('<summary>Show details</summary>')
    expect(html).not.toContain('<div class="meta">')
    expect(html).toContain('Request: /about/&lt;img&gt;')
    expect(html).toContain(`Error ID: ${errorId}`)
    expect(html.indexOf('<summary>Show details</summary>'))
      .toBeLessThan(html.indexOf('Request: /about/&lt;img&gt;'))
    expect(html.indexOf('Request: /about/&lt;img&gt;'))
      .toBeLessThan(html.indexOf(`Error ID: ${errorId}`))
    expect(html.indexOf(`Error ID: ${errorId}`))
      .toBeLessThan(html.indexOf('at render (/app/Page.vue:1:1)'))
    expect(html).toContain('at render (/app/Page.vue:1:1)')
    expect(html).not.toContain('Path: /')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('Open in VS Code')
    expect(html).not.toContain('Source:')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('__open-in-editor')
  })

  it('renders a clickable project-relative source and collapsed compiler details', () => {
    const html = renderSsrErrorDocument('Application error', 'fallback', {
      errorId,
      viteBase: '/',
      development: {
        name: 'SyntaxError',
        message: 'Single file component can contain only one <template> element',
        plugin: 'vite:vue',
        source: '/project/src/<img>/HomeHero.vue',
        displaySource: 'src/<img>/HomeHero.vue',
        line: 10,
        column: 1,
        requestPathname: '/',
        frame: '<script>alert(1)</script>\n  9 | <template>',
        stack: 'SyntaxError: Single file component can contain only one <template> element',
      },
    })
    const openHref = createSsrDevelopmentOpenInEditorHref({
      displaySource: 'src/<img>/HomeHero.vue',
      line: 10,
      column: 1,
    })
    expect(html).toContain('background:#000')
    expect(html).toContain('flex-direction:column')
    expect(html).toContain('<div class="stack">')
    expect(html).toContain('Single file component can contain only one &lt;template&gt; element')
    expect(html).toContain('vite:vue · SyntaxError')
    expect(html).not.toContain('[plugin:vite:vue]')
    expect(html).toContain('src/&lt;img&gt;/HomeHero.vue:10:1')
    expect(html).toContain(`href="${openHref}"`)
    expect(html).toContain('data-ssr-open-source')
    expect(html).toContain('__open-in-editor?file=')
    expect(html).toContain('fetch(link.href')
    expect(html).not.toContain('vscode:')
    expect(html).not.toContain('Source:')
    expect(html).not.toContain('Location:')
    expect(html).toContain('<details>')
    expect(html).not.toContain('<details open')
    expect(html).toContain('<summary>Show details</summary>')
    expect(html).not.toContain('<div class="meta">')
    expect(html).toContain('Request: /')
    expect(html).toContain(`Error ID: ${errorId}`)
    expect(html.indexOf('<summary>Show details</summary>'))
      .toBeLessThan(html.indexOf('Request: /'))
    expect(html.indexOf('Request: /'))
      .toBeLessThan(html.indexOf(`Error ID: ${errorId}`))
    expect(html.indexOf(`Error ID: ${errorId}`))
      .toBeLessThan(html.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;'))
    expect(html.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;'))
      .toBeLessThan(html.indexOf('  9 | &lt;template&gt;'))
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('  9 | &lt;template&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('Open in VS Code')
    expect(html).not.toContain('Path: /')
    expect(html.indexOf('src/&lt;img&gt;/HomeHero.vue:10:1'))
      .toBeLessThan(html.indexOf('vite:vue · SyntaxError'))
    expect(html.indexOf('class="source"'))
      .toBeLessThan(html.indexOf('class="pill"'))
  })

  it('omits empty source rows and keeps request metadata inside Show details', () => {
    const html = renderSsrErrorDocument('Application error', 'Cannot read properties of undefined (reading \'items\')', {
      errorId,
      development: {
        name: 'TypeError',
        message: 'Cannot read properties of undefined (reading \'items\')',
        requestPathname: '/',
      },
    })
    expect(html).toContain('<p class="pill">TypeError</p>')
    expect(html).not.toContain('class="source"')
    expect(html).not.toContain('__open-in-editor')
    expect(html).not.toContain('fetch(link.href')
    expect(html).toContain('<details>')
    expect(html).not.toContain('<details open')
    expect(html).toContain('<summary>Show details</summary>')
    expect(html).not.toContain('<div class="meta">')
    expect(html).not.toContain('<pre>')
    expect(html).toContain('Request: /')
    expect(html).toContain(`Error ID: ${errorId}`)
    expect(html.indexOf('<summary>Show details</summary>'))
      .toBeLessThan(html.indexOf('Request: /'))
    expect(html.indexOf('Request: /'))
      .toBeLessThan(html.indexOf(`Error ID: ${errorId}`))
  })

  it('renders a project-relative source without inventing a location', () => {
    const html = renderSsrErrorDocument('Application error', 'failed', {
      development: {
        displaySource: 'src/HomeHero.vue',
        source: '/project/src/HomeHero.vue',
      },
    })
    expect(html).toContain('>src/HomeHero.vue<')
    expect(html).toContain('href="/__open-in-editor?file=src%2FHomeHero.vue"')
    expect(html).not.toContain('src/HomeHero.vue:10')
    expect(html).not.toContain('Open in VS Code')
    expect(html).not.toContain('vscode:')
  })

  it('renders the timeout semantics on the dark production shell', () => {
    const html = renderSsrPublicErrorDocument(504, { errorId })
    expect(html).toContain('<p class="status">504 · Gateway Timeout</p>')
    expect(html).toContain('<h1>Request timed out</h1>')
    expect(html).toContain('The server took too long to respond. Please try again.')
    expect(html).toContain('background:#000')
    expect(html).not.toContain('Show details')
    expect(html).not.toContain('vscode:')
    expect(html).not.toContain('__open-in-editor')
    expect(html).not.toContain('data-ssr-open-source')
  })

  it('keeps unsafe or non-project sources readable without an editor-opening link', () => {
    for (const displaySource of ['javascript:alert(1)', '../secret.vue', '/etc/passwd', 'https://example.com/HomeHero.vue']) {
      const html = renderSsrErrorDocument('Application error', 'failed', {
        development: { displaySource },
      })
      expect(html).toContain(`<span class="source">${displaySource}</span>`)
      expect(html).not.toContain('__open-in-editor')
      expect(html).not.toContain('href="javascript:')
      expect(html).not.toContain('data-ssr-open-source')
      expect(html).not.toContain('<a ')
    }
  })

  it('builds an editor-neutral Vite open-in-editor href from a project-local file', () => {
    expect(createSsrDevelopmentOpenInEditorHref({
      displaySource: 'src/My File.vue',
      line: 4,
      column: 2,
    }, '/app')).toBe('/app/__open-in-editor?file=src%2FMy%20File.vue%3A4%3A2')
    expect(createSsrDevelopmentOpenInEditorHref({
      displaySource: 'src/HomeHero.vue',
    })).toBe('/__open-in-editor?file=src%2FHomeHero.vue')
    expect(createSsrDevelopmentOpenInEditorHref({
      displaySource: '../outside.vue',
      line: 1,
      column: 1,
    })).toBeUndefined()
    expect(createSsrDevelopmentOpenInEditorHref({
      displaySource: 'javascript:alert(1)',
    })).toBeUndefined()
  })
})
