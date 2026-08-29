// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  collectManagedHeadSnapshot,
  flattenHeadContribution,
  linkHeadKey,
  metaHeadKey,
  normalizeManagedScriptContent,
  reconcileManagedHead,
  serializeJsonLd,
  serializeManagedHead,
} from './SsrManagedHead'

describe('managed head pipeline', () => {
  it('uses explicit keys and derived identities', () => {
    expect(metaHeadKey({ name: 'author', content: 'Ada' })).toBe('author:Ada')
    expect(
      metaHeadKey({ key: 'theme', name: 'theme-color', content: '#000' })
    ).toBe('theme')
    expect(
      linkHeadKey({
        rel: 'alternate',
        hreflang: 'ar',
        href: '/ar',
      })
    ).toBe('alternate:ar::/ar')
  })

  it('lets a later same-key contribution win', () => {
    const snapshot = collectManagedHeadSnapshot([
      {
        name: 'seo',
        read: () => ({ title: 'Built-in' }),
      },
      {
        name: 'custom',
        read: () => ({ title: 'Override' }),
      },
    ])
    expect(snapshot.title).toBe('Override')
    expect(snapshot.tags).toHaveLength(1)
  })

  it('preserves the underlying head validation message during development', () => {
    expect(() => collectManagedHeadSnapshot([{
      name: 'seo',
      read: () => { throw new Error('seo.canonical must be same-origin') },
    }])).toThrow(/seo\.canonical must be same-origin/)
  })

  it('escapes JSON-LD script breakout', () => {
    const encoded = serializeJsonLd({
      name: '</script><script>alert(1)</script>',
    })
    expect(encoded).toContain('\\u003c/script\\u003e')
    expect(encoded).not.toContain('</script>')
    expect(
      serializeManagedHead({
        tags: [
          {
            key: 'json-ld',
            tag: 'script',
            attrs: { type: 'application/ld+json' },
            textContent: encoded,
          },
        ],
      })
    ).toContain('data-vue-ssr-lite-head="json-ld"')
  })

  it('canonically neutralizes generic managed script breakouts without changing JSON data', () => {
    const original = {
      value: '</script><script id="injected">alert(1)</script>',
      mixedCase: '</ScRiPt><script id="mixed">alert(2)</SCRIPT>',
    }
    const { tags } = flattenHeadContribution({
      scripts: [
        {
          key: 'page-data',
          type: 'application/json',
          content: JSON.stringify(original),
        },
      ],
    })
    const pageData = tags[0]!
    const html = serializeManagedHead({ tags })

    expect(pageData.textContent).not.toMatch(/<\/script/i)
    expect(JSON.parse(pageData.textContent!)).toEqual(original)
    expect(html.match(/data-vue-ssr-lite-head="page-data"/g)).toHaveLength(1)
    expect(html).not.toContain('</script><script id="injected">')
    expect(html).not.toContain('</ScRiPt><script id="mixed">')

    const parsed = new DOMParser().parseFromString(
      `<!doctype html><html><head>${html}</head><body></body></html>`,
      'text/html'
    )
    const intended = parsed.head.querySelector(
      'script[data-vue-ssr-lite-head="page-data"]'
    )
    expect(parsed.head.querySelectorAll('script')).toHaveLength(1)
    expect(parsed.getElementById('injected')).toBeNull()
    expect(parsed.getElementById('mixed')).toBeNull()
    expect(JSON.parse(intended!.textContent!)).toEqual(original)

    const reconciled = document.implementation.createHTMLDocument('managed head')
    reconcileManagedHead(reconciled.head, { tags })
    expect(
      reconciled.head.querySelector(
        'script[data-vue-ssr-lite-head="page-data"]'
      )?.textContent
    ).toBe(pageData.textContent)
  })

  it('normalizes every closing sequence idempotently and preserves empty content', () => {
    const hostile = 'first </script> second </SCRIPT\t> third </ScRiPt >'
    const normalized = normalizeManagedScriptContent(hostile)

    expect(normalized).toBe('first <\\/script> second <\\/SCRIPT\t> third <\\/ScRiPt >')
    expect(normalizeManagedScriptContent(normalized)).toBe(normalized)
    expect(normalizeManagedScriptContent('')).toBe('')
  })

  it('flattens title, meta, and links into stable tags', () => {
    const { tags } = flattenHeadContribution({
      title: 'About',
      meta: [{ key: 'description', name: 'description', content: 'Hello' }],
      links: [{ key: 'canonical', rel: 'canonical', href: 'https://ex.com/about' }],
    })
    expect(tags.map((tag) => tag.key)).toEqual([
      'title',
      'description',
      'canonical',
    ])
  })
})
