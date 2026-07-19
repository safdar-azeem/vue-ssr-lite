import type { SsrHeaderValue } from './SsrRuntimeTypes'

const firstHeaderValue = (value: SsrHeaderValue): string =>
  String(Array.isArray(value) ? value[0] : value || '')
    .split(',', 1)[0]
    .trim()

/**
 * Canonical authority normalizer used by host matching, domain context,
 * config compilation, proxy resolution, and URL generation.
 *
 * Returns `hostname` optionally with `:port`. Empty string when invalid.
 */
export const normalizeSsrHost = (host: SsrHeaderValue): string => {
  const raw = firstHeaderValue(host)
    .replace(/^(?:https?):?(?:\/\/)/i, '')
    .split(/[/?#]/, 1)[0]
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

/** Hostname without port (IPv6 unwrapped). */
export const stripSsrHostPort = (host: SsrHeaderValue): string => {
  const normalized = normalizeSsrHost(host)
  if (!normalized) return ''
  if (normalized.startsWith('[')) {
    const end = normalized.indexOf(']')
    return end > 0 ? normalized.slice(1, end) : ''
  }
  return normalized.replace(/:\d+$/, '')
}

/**
 * Hostname-only form for domain context and URL building.
 * Rejects values that are not a valid host after normalization.
 */
export const normalizeSsrHostname = (host: SsrHeaderValue): string =>
  stripSsrHostPort(host)

export const normalizeSsrHostPattern = (pattern: string): string => {
  const value = pattern.trim().toLowerCase()
  if (value === '*') return '*'
  if (value.startsWith('*.')) {
    const base = stripSsrHostPort(value.slice(2))
    return base && !base.includes(':') && !base.includes('*')
      ? `*.${base}`
      : ''
  }
  return normalizeSsrHost(value)
}
