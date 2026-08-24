import { describe, expect, it } from 'vitest'
import {
  collectManagedHeadSnapshot,
  flattenHeadContribution,
  linkHeadKey,
  metaHeadKey,
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
