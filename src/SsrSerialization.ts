import type { SsrHeadPayload } from './SsrRuntimeTypes'

export const escapeSsrHtml = (value: unknown): string =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

export const serializeSsrState = (value: unknown): string =>
  (JSON.stringify(value) ?? 'null')
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')

const normalizeKeywords = (value: SsrHeadPayload['keywords']): string =>
  Array.isArray(value) ? value.filter(Boolean).join(', ') : String(value ?? '')

const renderMeta = (
  attribute: 'name' | 'property',
  name: string,
  content: unknown
): string => {
  if (content == null || content === '') return ''
  return `<meta data-vue-ssr-lite-head ${attribute}="${escapeSsrHtml(name)}" content="${escapeSsrHtml(content)}">`
}

export const renderSsrHead = (payload: SsrHeadPayload | null): string => {
  const head = payload ?? { title: 'Application', robots: 'noindex, nofollow' }
  const tags: string[] = []
  if (head.title) {
    tags.push(
      `<title data-vue-ssr-lite-head>${escapeSsrHtml(head.title)}</title>`
    )
  }
  const metadata: Array<['name' | 'property', string, unknown]> = [
    ['name', 'description', head.description],
    ['name', 'keywords', normalizeKeywords(head.keywords)],
    ['name', 'robots', head.robots],
    ['property', 'og:title', head.ogTitle],
    ['property', 'og:description', head.ogDescription],
    ['property', 'og:image', head.ogImage],
    ['property', 'og:image:alt', head.ogImageAlt],
    ['property', 'og:url', head.ogUrl],
    ['property', 'og:type', head.ogType],
    ['property', 'og:site_name', head.ogSiteName],
    ['property', 'og:locale', head.ogLocale],
    ['name', 'twitter:card', head.twitterCard],
    ['name', 'twitter:title', head.twitterTitle],
    ['name', 'twitter:description', head.twitterDescription],
    ['name', 'twitter:image', head.twitterImage],
    ['name', 'twitter:image:alt', head.twitterImageAlt],
    ['name', 'twitter:site', head.twitterSite],
    ['name', 'twitter:creator', head.twitterCreator],
  ]
  for (const [attribute, name, content] of metadata) {
    const rendered = renderMeta(attribute, name, content)
    if (rendered) tags.push(rendered)
  }
  if (head.canonicalUrl) {
    tags.push(
      `<link data-vue-ssr-lite-head rel="canonical" href="${escapeSsrHtml(head.canonicalUrl)}">`
    )
  }
  if (head.favicon) {
    tags.push(
      `<link data-vue-ssr-lite-head rel="icon" href="${escapeSsrHtml(head.favicon)}">`
    )
  }
  for (const block of head.jsonLd ?? []) {
    tags.push(
      `<script data-vue-ssr-lite-head type="application/ld+json">${serializeSsrState(block)}</script>`
    )
  }
  return tags.join('')
}

export const sanitizeSsrIdentifier = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'app'

export const getSsrStateElementId = (applicationId: string): string =>
  `vue-ssr-lite-state-${sanitizeSsrIdentifier(applicationId)}`
