import { describe, expect, it, vi } from 'vitest'
import { normalizeServerResponse, sanitizeFetchedResponseHeaders } from './SsrServerResponseRuntime'

const fetchedResponse = (body: BodyInit | null, init: ResponseInit): Response => {
  const response = new Response(body, init)
  Object.defineProperty(response, 'type', { value: 'basic' })
  return response
}

describe('server fetch Response normalization', () => {
  it('removes unchanged encoded byte validators and preserves middleware replacements', async () => {
    const response = normalizeServerResponse(fetchedResponse('decoded bytes', { headers: {
      'content-encoding': 'gzip',
      'content-length': '25',
      'content-md5': 'encoded-md5',
      'content-digest': 'sha-256=:encoded-content:',
      digest: 'sha-256=encoded-digest',
    } }))
    expect(response.headers.has('content-md5')).toBe(false)
    expect(response.headers.has('content-digest')).toBe(false)
    expect(response.headers.has('digest')).toBe(false)

    response.headers.set('content-digest', 'sha-256=:decoded-content:')
    sanitizeFetchedResponseHeaders(response)
    expect(response.headers.get('content-digest')).toBe('sha-256=:decoded-content:')
    expect(response.headers.has('content-md5')).toBe(false)
    expect(response.headers.has('digest')).toBe(false)
    await response.body?.cancel()
  })

  it('removes an unchanged encoded Repr-Digest and preserves a middleware replacement', async () => {
    const response = normalizeServerResponse(fetchedResponse('decoded representation', { headers: {
      'content-encoding': 'br',
      'content-length': '31',
      'repr-digest': 'sha-256=:encoded-representation:',
    } }))
    expect(response.headers.has('repr-digest')).toBe(false)

    response.headers.set('repr-digest', 'sha-256=:decoded-representation:')
    sanitizeFetchedResponseHeaders(response)
    expect(response.headers.get('repr-digest')).toBe('sha-256=:decoded-representation:')
    await response.body?.cancel()
  })

  it.each([
    { status: 206, range: undefined },
    { status: 206, range: 'bytes 0-9/20' },
    { status: 200, range: 'bytes 0-9/20' },
  ])('rejects a decoded fetched partial response before transport: %j', async ({ status, range }) => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const headers = new Headers({ 'content-encoding': 'gzip', 'content-length': '10' })
    if (range) headers.set('content-range', range)
    expect(() => normalizeServerResponse(fetchedResponse(body, { status, headers })))
      .toThrow('decoded fetched partial response')
    await Promise.resolve()
    expect(cancel).toHaveBeenCalledOnce()
  })
})
