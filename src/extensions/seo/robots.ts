import type { RobotsConfig, RobotsGroup } from './types'

const CONTROL = /[\u0000-\u001f\u007f]/
const DIRECTIVE = /^[A-Za-z][A-Za-z0-9-]*$/
const RESERVED = new Set(['user-agent', 'useragent', 'allow', 'disallow', 'sitemap'])

const list = (value: string | readonly string[] | undefined): string[] =>
  value === undefined ? [] : typeof value === 'string' ? [value] : [...value]

const safe = (value: unknown, label: string, max = 8192): string => {
  if (typeof value !== 'string' || CONTROL.test(value) || value.length > max) {
    throw new Error(`[vue-ssr-lite] ${label} contains invalid characters.`)
  }
  return value
}

const safeUrl = (value: string, siteOrigin?: string): string => {
  safe(value, 'robots sitemap URL')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('[vue-ssr-lite] robots sitemap URL must be absolute.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('[vue-ssr-lite] robots sitemap URL must be a credential-free HTTP(S) URL.')
  }
  if (siteOrigin && url.origin !== new URL(siteOrigin).origin) {
    throw new Error('[vue-ssr-lite] robots sitemap URL must be same-origin with siteOrigin.')
  }
  return url.href
}

export const normalizeRobotsConfig = (config: RobotsConfig = {}, siteOrigin?: string): {
  groups: RobotsGroup[]
  sitemaps: string[]
} => {
  const record = config as any
  if (record.groups !== undefined && (record.allow !== undefined || record.disallow !== undefined)) {
    throw new Error('[vue-ssr-lite] robots groups cannot be mixed with top-level allow/disallow.')
  }
  const groups: RobotsGroup[] = record.groups !== undefined
    ? [...record.groups]
    : [{ userAgents: '*', allow: list(record.allow).length ? list(record.allow) : ['/'], disallow: list(record.disallow) }]
  if (!groups.length) throw new Error('[vue-ssr-lite] robots groups cannot be empty.')
  for (const [index, group] of groups.entries()) {
    const agents = list(group.userAgents)
    if (!agents.length) throw new Error(`[vue-ssr-lite] robots group ${index + 1} needs a user-agent.`)
    agents.forEach((agent) => safe(agent, 'robots user-agent', 512))
    group.allow?.forEach((path) => safe(path, 'robots Allow'))
    group.disallow?.forEach((path) => safe(path, 'robots Disallow'))
    for (const [key, value] of Object.entries(group.directives ?? {})) {
      if (!DIRECTIVE.test(key) || RESERVED.has(key.toLowerCase())) {
        throw new Error(`[vue-ssr-lite] robots directive "${key}" is invalid or reserved.`)
      }
      if (typeof value === 'string') safe(value, `robots directive ${key}`)
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error(`[vue-ssr-lite] robots directive "${key}" must be finite.`)
      }
    }
  }
  return { groups, sitemaps: list(record.sitemaps).map((value) => safeUrl(value, siteOrigin)) }
}

export const serializeRobotsConfig = (config: RobotsConfig = {}, siteOrigin?: string): string => {
  const normalized = normalizeRobotsConfig(config, siteOrigin)
  const lines: string[] = []
  normalized.groups.forEach((group, index) => {
    if (index) lines.push('')
    for (const agent of list(group.userAgents)) lines.push(`User-agent: ${agent}`)
    for (const path of group.allow ?? []) lines.push(`Allow: ${path}`)
    for (const path of group.disallow ?? []) lines.push(`Disallow: ${path}`)
    for (const [key, value] of Object.entries(group.directives ?? {})) {
      if (value === false) continue
      lines.push(value === true ? key : `${key}: ${value}`)
    }
  })
  if (normalized.sitemaps.length) lines.push('')
  for (const sitemap of normalized.sitemaps) lines.push(`Sitemap: ${sitemap}`)
  lines.push('')
  return lines.join('\n')
}

/** Backward-compatible serializer signature used by the original endpoint. */
export const serializeRobotsTxt = (
  sitemapUrl: string | null,
  robotsTxt: RobotsConfig = {},
  siteOrigin?: string
): string => {
  const config = { ...(robotsTxt as any) }
  // An omitted value delegates advertisement of Core's managed sitemap to
  // Core. An explicit empty list is a deliberate private/unpublished opt-out.
  if (config.sitemaps === undefined && sitemapUrl) config.sitemaps = [sitemapUrl]
  return serializeRobotsConfig(config, siteOrigin)
}

export const privateRobotsConfig = (): RobotsConfig => ({
  groups: [{ userAgents: '*', disallow: ['/'] }],
})
