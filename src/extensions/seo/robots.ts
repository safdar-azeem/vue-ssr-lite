import type { SeoApplicationConfig } from './types'

export const serializeRobotsTxt = (
  sitemapUrl: string | null,
  robotsTxt: SeoApplicationConfig['robotsTxt'] = {}
): string => {
  const lines = ['User-agent: *']
  const allow = robotsTxt.allow?.length ? robotsTxt.allow : ['/']
  for (const path of allow) lines.push(`Allow: ${path}`)
  for (const path of robotsTxt.disallow ?? []) lines.push(`Disallow: ${path}`)
  if (sitemapUrl) {
    lines.push('', `Sitemap: ${sitemapUrl}`)
  }
  lines.push('')
  return lines.join('\n')
}
