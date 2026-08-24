import type {
  ManagedHeadContribution,
  ManagedHeadLinkEntry,
  ManagedHeadMetaEntry,
  ManagedHeadScriptEntry,
} from '../../SsrManagedHead'
import { serializeJsonLd } from '../../SsrManagedHead'
import type { NormalizedSeo } from './normalize'

const pushMeta = (
  meta: ManagedHeadMetaEntry[],
  key: string,
  attribute: 'name' | 'property',
  name: string,
  content: string | undefined
) => {
  if (!content) return
  meta.push({ key, [attribute]: name, content })
}

export const seoToHeadContribution = (
  seo: NormalizedSeo
): ManagedHeadContribution => {
  const meta: ManagedHeadMetaEntry[] = []
  const links: ManagedHeadLinkEntry[] = [...seo.links]
  const scripts: ManagedHeadScriptEntry[] = []

  pushMeta(meta, 'description', 'name', 'description', seo.description)
  pushMeta(meta, 'robots', 'name', 'robots', seo.robots)
  pushMeta(meta, 'og:title', 'property', 'og:title', seo.openGraph.title)
  pushMeta(
    meta,
    'og:description',
    'property',
    'og:description',
    seo.openGraph.description
  )
  pushMeta(meta, 'og:image', 'property', 'og:image', seo.openGraph.image)
  pushMeta(meta, 'og:url', 'property', 'og:url', seo.openGraph.url)
  pushMeta(meta, 'og:type', 'property', 'og:type', seo.openGraph.type)
  pushMeta(
    meta,
    'og:site_name',
    'property',
    'og:site_name',
    seo.openGraph.siteName
  )
  pushMeta(
    meta,
    'twitter:card',
    'name',
    'twitter:card',
    seo.twitter.card
  )
  pushMeta(meta, 'twitter:title', 'name', 'twitter:title', seo.twitter.title)
  pushMeta(
    meta,
    'twitter:description',
    'name',
    'twitter:description',
    seo.twitter.description
  )
  pushMeta(meta, 'twitter:image', 'name', 'twitter:image', seo.twitter.image)
  meta.push(...seo.meta)

  if (seo.canonical) {
    links.unshift({ key: 'canonical', rel: 'canonical', href: seo.canonical })
  }

  if (seo.structuredData) {
    const blocks = Array.isArray(seo.structuredData)
      ? seo.structuredData
      : [seo.structuredData]
    blocks.forEach((block, index) => {
      scripts.push({
        key: index === 0 ? 'json-ld' : `json-ld:${index}`,
        type: 'application/ld+json',
        content: serializeJsonLd(block),
      })
    })
  }

  return {
    title: seo.title,
    meta,
    links,
    scripts,
  }
}
