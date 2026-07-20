import type { SsrHeaderValue } from '../SsrRuntimeTypes'
import {
  normalizeSsrHost,
  normalizeSsrHostPattern,
  stripSsrHostPort,
} from '../SsrHostnameRuntime'

export {
  normalizeSsrHost,
  normalizeSsrHostPattern,
  stripSsrHostPort,
} from '../SsrHostnameRuntime'

/** Minimal host-owning application shape used by the matcher. */
export interface SsrHostApplication {
  id: string
  hosts: string[]
}

const firstHeaderValue = (value: SsrHeaderValue): string =>
  String(Array.isArray(value) ? value[0] : value || '')
    .split(',', 1)[0]
    .trim()

/** Exact matches always outrank wildcards (hostname max length is 253). */
const EXACT_SPECIFICITY_BASE = 1_000_000

export type SsrHostMatchCategory = 'exact' | 'wildcard' | 'catch-all' | 'default'

export interface SsrHostMatchScore {
  category: SsrHostMatchCategory
  /** Higher wins. Exact > longer wildcard suffix > shorter wildcard > catch-all. */
  specificity: number
  pattern: string
}

export interface SsrHostResolution<T extends SsrHostApplication = SsrHostApplication> {
  entry: T
  matchedPattern: string | null
  normalizedHostname: string
  category: SsrHostMatchCategory
  specificity: number
}

export class SsrHostConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrHostConfigurationError'
  }
}

export const matchesSsrHostPattern = (host: string, pattern: string): boolean => {
  const hostname = stripSsrHostPort(host)
  const normalizedPattern = normalizeSsrHostPattern(pattern)
  if (!hostname || !normalizedPattern) return false
  if (normalizedPattern === '*') return true
  if (normalizedPattern.startsWith('*.')) {
    return hostname.endsWith(`.${normalizedPattern.slice(2)}`)
  }
  return (
    normalizeSsrHost(host) === normalizedPattern ||
    hostname === stripSsrHostPort(normalizedPattern)
  )
}

/**
 * Score a single host pattern against a request host.
 * Returns null when the pattern is invalid or does not match.
 *
 * Precedence (higher specificity wins):
 * exact hostname > longer wildcard suffix > shorter wildcard suffix > `*`
 */
export const scoreSsrHostMatch = (
  host: string,
  pattern: string
): SsrHostMatchScore | null => {
  const hostname = stripSsrHostPort(host)
  const normalizedPattern = normalizeSsrHostPattern(pattern)
  if (!hostname || !normalizedPattern) return null
  if (!matchesSsrHostPattern(host, normalizedPattern)) return null

  if (normalizedPattern === '*') {
    return { category: 'catch-all', specificity: 0, pattern: normalizedPattern }
  }
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(2)
    return {
      category: 'wildcard',
      specificity: suffix.length,
      pattern: normalizedPattern,
    }
  }
  const exactHost = stripSsrHostPort(normalizedPattern)
  return {
    category: 'exact',
    specificity: EXACT_SPECIFICITY_BASE + exactHost.length,
    pattern: normalizedPattern,
  }
}

/**
 * Validate host patterns across compiled applications at startup.
 *
 * Rejects duplicate exact/wildcard ownership, invalid syntax, patterns that
 * carry protocols/paths/ports, and multiple catch-all applications. Overlapping
 * patterns with different specificity are allowed; the more specific pattern
 * wins at request time.
 */
export const validateSsrHostEntries = (
  applications: readonly SsrHostApplication[]
): void => {
  const owners = new Map<string, string>()
  const catchAllOwners: string[] = []

  for (const application of applications) {
    const entryHosts = application.hosts ?? []
    if (!entryHosts.length) {
      throw new SsrHostConfigurationError(
        `SSR application "${application.id}" requires at least one host pattern.`
      )
    }

    const seenInEntry = new Set<string>()
    for (const raw of entryHosts) {
      const trimmed = String(raw ?? '').trim()
      if (!trimmed) {
        throw new SsrHostConfigurationError(
          `SSR application "${application.id}" contains an empty host pattern.`
        )
      }
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /[/?#]/.test(trimmed)) {
        throw new SsrHostConfigurationError(
          `SSR application "${application.id}" host pattern "${raw}" must not include a protocol, path, or query.`
        )
      }

      const normalized = normalizeSsrHostPattern(trimmed)
      if (!normalized) {
        throw new SsrHostConfigurationError(
          `SSR application "${application.id}" has an invalid host pattern "${raw}". Use an exact hostname, *.example.com, or *.`
        )
      }
      const patternHasPort =
        normalized !== '*' &&
        (normalized.startsWith('[')
          ? /\]:\d+$/.test(normalized)
          : /:\d+$/.test(normalized))
      if (patternHasPort) {
        throw new SsrHostConfigurationError(
          `SSR application "${application.id}" host pattern "${raw}" must not include a port.`
        )
      }
      if (seenInEntry.has(normalized)) continue
      seenInEntry.add(normalized)

      if (normalized === '*') {
        catchAllOwners.push(application.id)
        continue
      }

      const previous = owners.get(normalized)
      if (previous && previous !== application.id) {
        throw new SsrHostConfigurationError(
          `Host pattern "${normalized}" is assigned to both "${previous}" and "${application.id}".`
        )
      }
      owners.set(normalized, application.id)
    }
  }

  if (catchAllOwners.length > 1) {
    throw new SsrHostConfigurationError(
      `Multiple catch-all ("*") host applications are not allowed (applications: ${catchAllOwners.join(', ')}).`
    )
  }
}

/**
 * Resolve the application entry for a request host using specificity, not
 * declaration order.
 *
 * Precedence:
 * exact hostname >
 * longest matching wildcard suffix >
 * shorter matching wildcard suffix >
 * catch-all `*` >
 * `defaultEntryId`
 */
export const resolveSsrHostEntry = <T extends SsrHostApplication>(
  applications: readonly T[],
  host: string,
  defaultApplicationId?: string
): SsrHostResolution<T> | null => {
  const normalizedHostname = stripSsrHostPort(host)
  if (!normalizedHostname) return null

  let best: SsrHostResolution<T> | null = null

  for (const entry of applications) {
    for (const pattern of entry.hosts ?? []) {
      const score = scoreSsrHostMatch(host, pattern)
      if (!score) continue

      const candidate: SsrHostResolution<T> = {
        entry,
        matchedPattern: score.pattern,
        normalizedHostname,
        category: score.category,
        specificity: score.specificity,
      }

      if (!best || candidate.specificity > best.specificity) {
        best = candidate
        continue
      }
      if (candidate.specificity < best.specificity) continue

      if (candidate.entry.id < best.entry.id) {
        best = candidate
      }
    }
  }

  if (best) return best

  if (!defaultApplicationId) return null
  const fallback = applications.find(
    (entry) => entry.id === defaultApplicationId
  )
  if (!fallback) return null
  return {
    entry: fallback,
    matchedPattern: null,
    normalizedHostname,
    category: 'default',
    specificity: -1,
  }
}

export const resolveSsrForwardedHost = (
  forwardedHost: SsrHeaderValue,
  host: SsrHeaderValue,
  trustProxy = false
): string =>
  normalizeSsrHost(trustProxy ? firstHeaderValue(forwardedHost) || host : host)

export const resolveSsrForwardedProtocol = (
  forwardedProtocol: SsrHeaderValue,
  fallback: 'http' | 'https',
  trustProxy = false
): 'http' | 'https' => {
  if (!trustProxy) return fallback
  const protocol = firstHeaderValue(forwardedProtocol).toLowerCase()
  return protocol === 'http' || protocol === 'https' ? protocol : fallback
}

const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * Cookie passthrough for SSR upstream/client fetches:
 * - both empty → forward nothing (secure default)
 * - allow empty + deny non-empty → forward all except deny
 * - allow non-empty → allow ∩ ¬deny
 */
export const filterSsrCookieHeader = (
  cookieHeader: SsrHeaderValue,
  allowlist: readonly string[] = [],
  denylist: readonly string[] = []
): string | undefined => {
  const allowed = new Set(allowlist.filter((name) => COOKIE_NAME.test(name)))
  const denied = new Set(denylist.filter((name) => COOKIE_NAME.test(name)))
  if (!cookieHeader) return
  if (allowed.size === 0 && denied.size === 0) return
  const cookies = String(cookieHeader)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const separator = part.indexOf('=')
      if (separator <= 0) return false
      const name = part.slice(0, separator).trim()
      if (denied.has(name)) return false
      if (allowed.size === 0) return true
      return allowed.has(name)
    })
  return cookies.length ? cookies.join('; ') : undefined
}
