import type { SsrHeaders } from '../SsrRuntimeTypes'

const normalized = new WeakSet<Response>()
type FetchResponseMetadata = {
  decoded: boolean
  etag: string | null
  representationIntegrity: Readonly<Record<string, string | null>>
  connectionFields: string[]
}
const fetchedResponses = new WeakMap<Response, FetchResponseMetadata>()
const fetchedBodies = new WeakMap<ReadableStream<Uint8Array>, FetchResponseMetadata>()
const FETCH_DECODED_ENCODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br'])
const HOP_BY_HOP_HEADERS = [
  'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization',
]
const ENCODED_REPRESENTATION_INTEGRITY_FIELDS = [
  'content-md5', 'content-digest', 'repr-digest', 'digest',
] as const
const connectionFields = (headers: Headers): string[] =>
  (headers.get('connection') ?? '').split(',').map((name) => name.trim().toLowerCase())
    .filter((name) => /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name))

const fetchMetadata = (response: Response): FetchResponseMetadata | undefined => {
  const known = fetchedResponses.get(response) ?? (response.body ? fetchedBodies.get(response.body) : undefined)
  if (known) return known
  // Capture native Fetch provenance before new Response() resets type/url.
  // Locally constructed Responses (including file assets) have type "default".
  if (response.type !== 'basic' && response.type !== 'cors') return undefined
  const encodings = (response.headers.get('content-encoding') ?? '').toLowerCase().split(',').map((value) => value.trim())
  return {
    // HEAD/304 have no decoded stream. Unknown codings are passed through by
    // Node Fetch, so their representation headers must remain intact.
    decoded: response.body !== null && encodings.every((encoding) => FETCH_DECODED_ENCODINGS.has(encoding)),
    etag: response.headers.get('etag'),
    representationIntegrity: Object.fromEntries(
      ENCODED_REPRESENTATION_INTEGRITY_FIELDS.map((name) => [name, response.headers.get(name)])
    ),
    connectionFields: connectionFields(response.headers),
  }
}

/** Recheck after middleware, before Node commits headers on its own connection. */
export const sanitizeFetchedResponseHeaders = (response: Response): void => {
  const metadata = fetchedResponses.get(response)
  if (!metadata) return
  const headers = response.headers
  const nominated = [...metadata.connectionFields, ...connectionFields(headers)]
  for (const name of [...HOP_BY_HOP_HEADERS, ...nominated]) headers.delete(name)
  if (metadata.decoded) {
    headers.delete('content-encoding')
    headers.delete('content-length')
    // Remove only validators inherited from the encoded upstream representation.
    // Middleware can deliberately replace them with decoded-representation values.
    for (const name of ENCODED_REPRESENTATION_INTEGRITY_FIELDS) {
      const original = metadata.representationIntegrity[name]
      if (original !== null && headers.get(name) === original) headers.delete(name)
    }
    if (metadata.etag && !metadata.etag.startsWith('W/') && headers.get('etag') === metadata.etag) headers.delete('etag')
  }
}
const legacyHeaders = new WeakMap<Response, Array<{ name: string; value: string | string[]; projected: string | null }>>()

/** Preserve Node header multiplicity while Web middleware sees ordinary Headers. */
export const rememberLegacyResponseHeaders = (response: Response, headers: SsrHeaders): void => {
  legacyHeaders.set(response, Object.entries(headers).flatMap(([name, value]) =>
    value === undefined ? [] : [{ name, value: typeof value === 'string' ? value : [...value], projected: response.headers.get(name) }]
  ))
}

export const unchangedLegacyResponseHeaders = (response: Response): SsrHeaders =>
  Object.fromEntries((legacyHeaders.get(response) ?? [])
    .filter(({ name, projected }) => response.headers.has(name) && response.headers.get(name) === projected)
    .map(({ name, value }) => [name.toLowerCase(), value]))

/** One boundary for route/middleware returns. Rewrap streams, never clone/tee or buffer them. */
export const normalizeServerResponse = (value: unknown): Response => {
  if (!(value instanceof Response)) {
    throw new TypeError(`Server route handler or middleware must return a native Response instance; received ${value === null ? 'null' : typeof value}.`)
  }
  if (!Number.isInteger(value.status) || value.status < 200 || value.status > 599) {
    throw new TypeError(`Server route handler or middleware returned a Response with invalid HTTP status ${value.status}.`)
  }
  if (value.bodyUsed || value.body?.locked) {
    throw new TypeError('Server route handler or middleware returned a consumed or locked Response body.')
  }
  if (normalized.has(value)) return value
  const fetched = fetchMetadata(value)
  if (fetched?.decoded && (value.status === 206 || value.headers.has('content-range'))) {
    const error = new TypeError(
      'A decoded fetched partial response cannot be represented with valid Content-Range metadata.'
    )
    if (value.body && !value.body.locked) void value.body.cancel(error).catch(() => undefined)
    throw error
  }
  const response = new Response(value.body, {
    status: value.status, statusText: value.statusText, headers: value.headers,
  })
  const originalHeaders = legacyHeaders.get(value)
  if (originalHeaders) legacyHeaders.set(response, originalHeaders)
  if (fetched) {
    fetchedResponses.set(response, fetched)
    if (response.body) fetchedBodies.set(response.body, fetched)
    // Middleware should see headers describing the stream it actually receives.
    // Early cleanup also keeps ordinary Response.clone() copies safe.
    sanitizeFetchedResponseHeaders(response)
  }
  normalized.add(response)
  return response
}
