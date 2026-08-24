import {
  resolveAbsoluteAssetUrl,
  resolveCanonicalHref,
} from '../../SsrCanonicalOrigin'
import { isErrorResponseStatus } from '../../SsrResponseStatus'
import type { SeoApplicationConfig, SeoInput } from './types'
import { isPrivateSeoMode } from './types'

export interface NormalizedSeo {
  title: string | undefined
  description: string | undefined
  canonical: string | null
  robots: string
  image: string | undefined
  openGraph: {
    type: string
    title: string | undefined
    description: string | undefined
    image: string | undefined
    url: string | undefined
    siteName: string | undefined
  }
  twitter: {
    card: string
    title: string | undefined
    description: string | undefined
    image: string | undefined
  }
  structuredData: SeoInput['structuredData']
  meta: NonNullable<SeoInput['meta']>
  links: NonNullable<SeoInput['links']>
}

const applyTitleTemplate = (
  title: string | undefined,
  config: SeoApplicationConfig
): string | undefined => {
  if (!title) return config.title
  if (!config.titleTemplate) return title
  if (title === config.title) return title
  return config.titleTemplate.replaceAll('%s', title)
}

const robotsContent = (
  input: SeoInput,
  config: SeoApplicationConfig,
  status: number
): string => {
  const index = isErrorResponseStatus(status)
    ? false
    : input.index ?? (isPrivateSeoMode(config) ? false : true)
  const follow = input.follow ?? (isPrivateSeoMode(config) ? false : true)
  const tokens = [index ? 'index' : 'noindex', follow ? 'follow' : 'nofollow']
  if (input.robots?.noarchive) tokens.push('noarchive')
  if (input.robots?.nosnippet) tokens.push('nosnippet')
  if (input.robots?.maxSnippet != null) {
    tokens.push(`max-snippet:${input.robots.maxSnippet}`)
  }
  if (input.robots?.maxImagePreview) {
    tokens.push(`max-image-preview:${input.robots.maxImagePreview}`)
  }
  return tokens.join(', ')
}

export interface NormalizeSeoOptions {
  config: SeoApplicationConfig
  input: SeoInput
  origin: string
  path: string
  status: number
}

export const normalizeSeo = (options: NormalizeSeoOptions): NormalizedSeo => {
  const { config, input, origin, path, status } = options
  const title = applyTitleTemplate(input.title, config)
  const description = input.description ?? config.description
  const image = resolveAbsoluteAssetUrl(origin, input.image ?? config.image)
  const privateMode = isPrivateSeoMode(config)
  const canonical = privateMode
    ? null
    : resolveCanonicalHref(origin, path, input.canonical, config.trailingSlash)
  const og = input.openGraph ?? {}
  const twitter = input.twitter ?? {}

  return {
    title,
    description,
    canonical,
    robots: robotsContent(input, config, status),
    image,
    openGraph: {
      type: og.type ?? 'website',
      title: og.title ?? title,
      description: og.description ?? description,
      image: resolveAbsoluteAssetUrl(origin, og.image) ?? image,
      url: og.url ?? canonical ?? undefined,
      siteName: config.siteName,
    },
    twitter: {
      card: twitter.card ?? (image ? 'summary_large_image' : 'summary'),
      title: twitter.title ?? title,
      description: twitter.description ?? description,
      image: resolveAbsoluteAssetUrl(origin, twitter.image) ?? image,
    },
    structuredData: input.structuredData,
    meta: input.meta ?? [],
    links: input.links ?? [],
  }
}
