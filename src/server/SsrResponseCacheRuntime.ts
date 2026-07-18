import type {
  SsrHttpRequest,
  SsrHttpResponse,
  SsrResponseCache,
  SsrResponseCacheInvalidation,
  SsrResponseCacheStrategy,
  SsrResponseCacheWriteOptions,
} from '../SsrRuntimeTypes'

export interface SsrMemoryResponseCacheOptions {
  maxEntries?: number
  maxBytes?: number
}

interface SsrMemoryResponseCacheEntry {
  response: SsrHttpResponse
  expiresAt: number
  size: number
  tags: Set<string>
}

const byteLength = (body: SsrHttpResponse['body']): number =>
  typeof body === 'string'
    ? new TextEncoder().encode(body).byteLength
    : body?.byteLength ?? 0

const cloneResponse = (response: SsrHttpResponse): SsrHttpResponse => ({
  statusCode: response.statusCode,
  body: response.body instanceof Uint8Array ? response.body.slice() : response.body,
  headers: response.headers ? { ...response.headers } : undefined,
})

export const createSsrMemoryResponseCache = (
  options: SsrMemoryResponseCacheOptions = {}
): SsrResponseCache => {
  const configuredEntries = Number(options.maxEntries ?? 500)
  const configuredBytes = Number(options.maxBytes ?? 32 * 1024 * 1024)
  const maxEntries = Number.isFinite(configuredEntries)
    ? Math.max(1, Math.floor(configuredEntries))
    : 500
  const maxBytes = Number.isFinite(configuredBytes)
    ? Math.max(1, Math.floor(configuredBytes))
    : 32 * 1024 * 1024
  const entries = new Map<string, SsrMemoryResponseCacheEntry>()
  let totalBytes = 0

  const remove = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return false
    entries.delete(key)
    totalBytes -= entry.size
    return true
  }

  const prune = () => {
    const now = Date.now()
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) remove(key)
    }
    while (entries.size > maxEntries || totalBytes > maxBytes) {
      const oldest = entries.keys().next().value as string | undefined
      if (!oldest) break
      remove(oldest)
    }
  }

  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return null
      if (entry.expiresAt <= Date.now()) {
        remove(key)
        return null
      }
      entries.delete(key)
      entries.set(key, entry)
      return cloneResponse(entry.response)
    },
    set(
      key: string,
      response: SsrHttpResponse,
      writeOptions: SsrResponseCacheWriteOptions
    ) {
      const ttlMs = Number(writeOptions.ttlMs)
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) return
      remove(key)
      const stored = cloneResponse(response)
      const size = byteLength(stored.body)
      if (size > maxBytes) return
      entries.set(key, {
        response: stored,
        expiresAt: Date.now() + ttlMs,
        size,
        tags: new Set(writeOptions.tags ?? []),
      })
      totalBytes += size
      prune()
    },
    invalidate(selector: SsrResponseCacheInvalidation = {}) {
      const keys = new Set(selector.keys ?? [])
      const tags = new Set(selector.tags ?? [])
      let removed = 0
      for (const [key, entry] of entries) {
        const selected =
          (!keys.size && !tags.size) ||
          keys.has(key) ||
          [...tags].some((tag) => entry.tags.has(tag))
        if (selected && remove(key)) removed += 1
      }
      return removed
    },
  }
}

export const resolveSsrResponseCacheKey = async (
  entryId: string,
  request: SsrHttpRequest<any>,
  strategy: SsrResponseCacheStrategy<any> | undefined
): Promise<string | null> => {
  if (
    !strategy ||
    request.method !== 'GET' ||
    request.cookie ||
    !Number.isFinite(strategy.ttlMs) ||
    strategy.ttlMs <= 0
  ) {
    return null
  }
  const variation = strategy.vary ? await strategy.vary(request) : ''
  if (variation == null) return null
  return JSON.stringify([
    'vue-ssr-lite:v1',
    entryId,
    request.host,
    request.pathname,
    request.search,
    variation,
  ])
}

export const isSsrResponseCacheable = (
  response: SsrHttpResponse,
  request: SsrHttpRequest<any>,
  strategy: SsrResponseCacheStrategy<any>
): boolean => {
  const headers = Object.entries(response.headers ?? {})
  const cacheControl = String(
    headers.find(([name]) => name.toLowerCase() === 'cache-control')?.[1] || ''
  ).toLowerCase()
  const safe =
    response.statusCode === 200 &&
    typeof response.body === 'string' &&
    !headers.some(([name]) => name.toLowerCase() === 'set-cookie') &&
    !cacheControl.includes('private') &&
    !cacheControl.includes('no-store')
  return safe && (strategy.shouldCache?.(response, request) ?? true)
}
