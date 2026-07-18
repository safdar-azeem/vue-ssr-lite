import type { SsrHeaderValue, SsrRuntimeEntry } from '../SsrRuntimeTypes'

const firstHeaderValue = (value: SsrHeaderValue): string =>
  String(Array.isArray(value) ? value[0] : value || '')
    .split(',', 1)[0]
    .trim()

export const normalizeSsrHost = (host: SsrHeaderValue): string => {
  const raw = firstHeaderValue(host)
  if (
    !raw ||
    raw.length > 512 ||
    /[\u0000-\u0020\u007f]/.test(raw) ||
    /[\\/@?#]/.test(raw)
  ) {
    return ''
  }
  try {
    const authority =
      raw.includes(':') && raw.split(':').length > 2 && !raw.startsWith('[')
        ? `[${raw}]`
        : raw
    const parsed = new URL(`http://${authority}`)
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return ''
    }
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
    if (!hostname) return ''
    const displayHost =
      hostname.includes(':') && !hostname.startsWith('[')
        ? `[${hostname}]`
        : hostname
    return `${displayHost}${parsed.port ? `:${parsed.port}` : ''}`
  } catch {
    return ''
  }
}

export const stripSsrHostPort = (host: SsrHeaderValue): string => {
  const normalized = normalizeSsrHost(host)
  if (!normalized) return ''
  if (normalized.startsWith('[')) {
    const end = normalized.indexOf(']')
    return end > 0 ? normalized.slice(1, end) : ''
  }
  return normalized.replace(/:\d+$/, '')
}

export const normalizeSsrHostPattern = (pattern: string): string => {
  const value = pattern.trim().toLowerCase()
  if (value === '*') return '*'
  if (value.startsWith('*.')) {
    const base = stripSsrHostPort(value.slice(2))
    // A single leading label wildcard only. Reject nested wildcards
    // (`*.*.example.com`) and ports.
    return base && !base.includes(':') && !base.includes('*')
      ? `*.${base}`
      : ''
  }
  return normalizeSsrHost(value)
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

export const resolveSsrEntry = (
  entries: SsrRuntimeEntry[],
  host: string,
  defaultEntryId?: string
): SsrRuntimeEntry | null => {
  const explicit = entries.find((entry) =>
    entry.hosts.some(
      (pattern) => pattern !== '*' && matchesSsrHostPattern(host, pattern)
    )
  )
  if (explicit) return explicit
  const wildcard = entries.find((entry) => entry.hosts.includes('*'))
  if (wildcard) return wildcard
  return entries.find((entry) => entry.id === defaultEntryId) ?? null
}

const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export const filterSsrCookieHeader = (
  cookieHeader: SsrHeaderValue,
  allowlist: readonly string[] = [],
  denylist: readonly string[] = []
): string | undefined => {
  const allowed = new Set(allowlist.filter((name) => COOKIE_NAME.test(name)))
  const denied = new Set(denylist.filter((name) => COOKIE_NAME.test(name)))
  if (!cookieHeader || allowed.size === 0) return
  const cookies = String(cookieHeader)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const separator = part.indexOf('=')
      if (separator <= 0) return false
      const name = part.slice(0, separator).trim()
      return allowed.has(name) && !denied.has(name)
    })
  return cookies.length ? cookies.join('; ') : undefined
}
