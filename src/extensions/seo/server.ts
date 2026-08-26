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
  content: string | number | undefined
) => {
  if (content === undefined) return
  meta.push({ key, [attribute]: name, content: String(content) })
}

const pushMedia = (
  meta: ManagedHeadMetaEntry[],
  kind: 'image' | 'audio' | 'video',
  entries: readonly {
    key?: string
    url: string
    secureUrl?: string
    type?: string
    width?: number
    height?: number
    alt?: string
  }[]
) => {
  entries.forEach((entry, index) => {
    const identity = entry.key ? `key:${entry.key}` : `index:${index}`
    const prefix = `og:${kind}:${identity}`
    pushMeta(meta, prefix, 'property', `og:${kind}`, entry.url)
    pushMeta(meta, `${prefix}:secure_url`, 'property', `og:${kind}:secure_url`, entry.secureUrl)
    pushMeta(meta, `${prefix}:type`, 'property', `og:${kind}:type`, entry.type)
    pushMeta(meta, `${prefix}:width`, 'property', `og:${kind}:width`, entry.width)
    pushMeta(meta, `${prefix}:height`, 'property', `og:${kind}:height`, entry.height)
    if ('alt' in entry) pushMeta(meta, `${prefix}:alt`, 'property', `og:${kind}:alt`, entry.alt)
  })
}

export const seoToHeadContribution = (seo: NormalizedSeo): ManagedHeadContribution => {
  const meta: ManagedHeadMetaEntry[] = []
  const links: ManagedHeadLinkEntry[] = [...seo.links]
  const scripts: ManagedHeadScriptEntry[] = []
  const ownsMeta = (attribute: 'name' | 'property', value: string): boolean =>
    seo.meta.some((entry) => entry[attribute]?.toLowerCase() === value.toLowerCase())

  if (!ownsMeta('name', 'description')) pushMeta(meta, 'description', 'name', 'description', seo.description)
  if (!ownsMeta('name', 'robots')) pushMeta(meta, 'robots', 'name', 'robots', seo.robots)
  pushMeta(meta, 'og:title', 'property', 'og:title', seo.openGraph.title)
  pushMeta(meta, 'og:description', 'property', 'og:description', seo.openGraph.description)
  if (!ownsMeta('property', 'og:url')) pushMeta(meta, 'og:url', 'property', 'og:url', seo.openGraph.url)
  pushMeta(meta, 'og:type', 'property', 'og:type', seo.openGraph.type)
  pushMeta(meta, 'og:site_name', 'property', 'og:site_name', seo.openGraph.siteName)
  pushMeta(meta, 'og:locale', 'property', 'og:locale', seo.openGraph.locale)
  pushMeta(meta, 'og:determiner', 'property', 'og:determiner', seo.openGraph.determiner)
  seo.openGraph.localeAlternate.forEach((locale) => {
    pushMeta(meta, `og:locale:alternate:${locale}`, 'property', 'og:locale:alternate', locale)
  })
  pushMedia(meta, 'image', seo.openGraph.images)
  pushMedia(meta, 'audio', seo.openGraph.audio)
  pushMedia(meta, 'video', seo.openGraph.video)
  pushMeta(meta, 'twitter:card', 'name', 'twitter:card', seo.twitter.card)
  pushMeta(meta, 'twitter:site', 'name', 'twitter:site', seo.twitter.site)
  pushMeta(meta, 'twitter:creator', 'name', 'twitter:creator', seo.twitter.creator)
  pushMeta(meta, 'twitter:title', 'name', 'twitter:title', seo.twitter.title)
  pushMeta(meta, 'twitter:description', 'name', 'twitter:description', seo.twitter.description)
  pushMeta(meta, 'twitter:image', 'name', 'twitter:image', seo.twitter.image)
  meta.push(...seo.meta)

  const genericCanonical = links.some((entry) => entry.rel.toLowerCase() === 'canonical')
  if (seo.canonical && !genericCanonical) {
    links.unshift({ key: 'canonical', rel: 'canonical', href: seo.canonical })
  }
  for (const [language, href] of Object.entries(seo.alternates)) {
    if (links.some((entry) =>
      entry.rel.toLowerCase() === 'alternate' &&
      entry.hreflang?.toLowerCase() === language.toLowerCase()
    )) continue
    links.push({ key: `alternate:${language.toLowerCase()}`, rel: 'alternate', hreflang: language, href })
  }

  seo.structuredData.forEach((block, index) => {
    const id = typeof block['@id'] === 'string' ? block['@id'] : undefined
    scripts.push({
      key: id ? `json-ld:${id}` : index === 0 ? 'json-ld' : `json-ld:unkeyed:${index}`,
      type: 'application/ld+json',
      content: serializeJsonLd(block),
    })
  })

  return {
    title: seo.title,
    meta,
    links,
    scripts,
    htmlAttributes: seo.htmlAttributes,
  }
}
