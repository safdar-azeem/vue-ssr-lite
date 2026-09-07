import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSsrRequestScope } from './SsrRequestHandler'
import { resolveSsrProductionAsset } from './SsrAssetRuntime'
import { createSsrRequestBodySource, createWebRequest, productionAssetToWebResponse, resolveProductionAssetResponse, ssrHttpResponseToWebResponse, writeWebResponse } from './SsrWebHttpRuntime'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const temporaryRoot = async () => { const root = await mkdtemp(join(tmpdir(), 'ssr-web-http-')); roots.push(root); return root }
const incoming = (method = 'POST') => Object.assign(new PassThrough(), { method }) as unknown as IncomingMessage
const nodeResponse = (write?: (chunk: Buffer, callback: (error?: Error | null) => void) => void) => {
  const chunks: Buffer[] = []
  const headers: Record<string, string | string[]> = {}
  const stream = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    chunks.push(Buffer.from(chunk))
    if (write) write(chunk, callback)
    else callback()
  } })
  const response = Object.assign(stream, {
    statusCode: 0, statusMessage: '',
    setHeader: (name: string, value: string | string[]) => { headers[name] = value },
  }) as unknown as ServerResponse
  return { response, headers, chunks }
}

describe('lazy request body transport bridge', () => {
  it.each(['TRACE', 'TRACK', 'CONNECT'])('rejects unrepresentable %s without opening a body', (method) => {
    const openBody = vi.fn(() => new ReadableStream<Uint8Array>())
    expect(() => createWebRequest({ requestId: 'forbidden', startedAt: 0, method, url: '/', protocol: 'http', headers: {}, openBody }, 'http://trusted.test/', new AbortController().signal))
      .toThrow('cannot be represented')
    expect(openBody).not.toHaveBeenCalled()
  })
  it.each(['GET', 'HEAD'])('does not provide a body opener for %s', (method) => {
    const scope = createSsrRequestScope(0)
    const source = createSsrRequestBodySource(incoming(method), scope.signal)
    expect(source.openBody).toBeUndefined()
    source.release(); scope.dispose()
  })

  it('opens exactly once and lets native Request parse a streamed payload', async () => {
    const raw = incoming()
    const scope = createSsrRequestScope(0)
    const source = createSsrRequestBodySource(raw, scope.signal)
    expect(raw.listenerCount('readable')).toBe(0)
    const openBody = vi.fn(source.openBody!)
    const request = createWebRequest({
      requestId: 'body', startedAt: 0, method: 'POST', url: '/api', headers: { 'content-type': 'application/json', 'x-values': ['a', 'b'] }, protocol: 'https', openBody,
    }, 'https://trusted.test/api?q=1', scope.signal)
    expect(openBody).toHaveBeenCalledOnce()
    expect(() => source.openBody!()).toThrow('Request body stream was already opened')
    const read = request.json()
    raw.push(Buffer.from('{"value":'))
    raw.push(Buffer.from('42}'))
    raw.push(null)
    expect(await read).toEqual({ value: 42 })
    expect(request.url).toBe('https://trusted.test/api?q=1')
    expect(request.headers.get('x-values')).toBe('a, b')
    expect(request.bodyUsed).toBe(true)
    source.release(); scope.dispose()
  })

  it('aborts native reads with the canonical request signal', async () => {
    const raw = incoming()
    const scope = createSsrRequestScope(0)
    const source = createSsrRequestBodySource(raw, scope.signal)
    const request = createWebRequest({ requestId: 'abort', startedAt: 0, method: 'POST', url: '/api', protocol: 'http', headers: {}, openBody: source.openBody }, 'http://trusted.test/api', scope.signal)
    const reading = request.text()
    const failure = new Error('canonical cancellation')
    scope.cancel(failure)
    await expect(reading).rejects.toThrow('canonical cancellation')
    expect(request.signal.aborted).toBe(true)
    expect(request.signal.reason).toBe(failure)
    source.release(); scope.dispose()
  })

  it('detaches an unread or partially read Web body before transport resumes Node', async () => {
    const raw = incoming()
    const scope = createSsrRequestScope(0)
    const source = createSsrRequestBodySource(raw, scope.signal)
    const reader = source.openBody!().getReader()
    const first = reader.read()
    raw.push(Buffer.from('first'))
    expect(new TextDecoder().decode((await first).value)).toBe('first')
    source.release()
    expect(raw.listenerCount('readable')).toBe(0)
    expect(raw.destroyed).toBe(false)
    const drained = new Promise<void>((resolve) => raw.once('end', resolve))
    raw.resume()
    raw.push(Buffer.alloc(128 * 1024))
    raw.push(null)
    await drained
    expect(raw.readableEnded).toBe(true)
    scope.dispose()
  })
})

describe('native response transport', () => {
  it('preserves encoding, length and strong validators on locally constructed byte Responses', async () => {
    const body = new Uint8Array(gzipSync('locally encoded representation'))
    const length = String(body.byteLength)
    const { response: output, headers, chunks } = nodeResponse()
    await writeWebResponse({ method: 'GET' }, output, new Response(body, { headers: {
      'content-encoding': 'gzip', 'content-length': length, etag: '"actual-bytes"',
    } }), new AbortController().signal)
    expect(headers).toEqual({ 'content-encoding': 'gzip', 'content-length': length, etag: '"actual-bytes"' })
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(body))
  })

  it('propagates a source-stream error and destroys the destination', async () => {
    const failure = new Error('source stream failed')
    let reads = 0
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode('partial'))
      else controller.error(failure)
    } }, { highWaterMark: 0 })
    const { response: output } = nodeResponse()
    await expect(writeWebResponse({ method: 'GET' }, output, new Response(body), new AbortController().signal))
      .rejects.toBe(failure)
    expect(output.destroyed).toBe(true)
  })

  it('rejects a status-0 Response before touching the outgoing HTTP status', async () => {
    const { response: output } = nodeResponse()
    output.statusCode = 200
    await expect(writeWebResponse({ method: 'GET' }, output, Response.error(), new AbortController().signal))
      .rejects.toThrow('invalid HTTP status 0')
    expect(output.statusCode).toBe(200)
    expect(output.writableEnded).toBe(false)
  })

  it.each([
    { name: 'string without content type', body: 'endpoint', headers: {} },
    { name: 'explicit content type', body: 'endpoint', headers: { 'Content-Type': 'application/custom' } },
    { name: 'bytes', body: new Uint8Array([0, 255, 127]), headers: {} },
    { name: 'repeated headers', body: 'endpoint', headers: { 'X-Repeated': ['one', 'two'], 'WWW-Authenticate': ['Basic realm="one"', 'Bearer realm="two"'] } },
    { name: 'cookies', body: 'endpoint', headers: { 'Set-Cookie': ['one=1', 'two=2; Expires=Wed, 21 Oct 2037 07:28:00 GMT'] } },
    { name: 'empty string', body: '', headers: {} },
    { name: 'absent body', body: undefined, headers: {} },
  ])('keeps legacy $name wire-compatible through Web adaptation', async ({ body, headers }) => {
    const legacy = { statusCode: 200, body, headers: headers as Record<string, string | string[]> }
    const response = ssrHttpResponseToWebResponse(legacy)
    const { response: output, headers: written, chunks } = nodeResponse()
    await writeWebResponse({ method: 'GET' }, output, response, new AbortController().signal)
    expect(written).toEqual(Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])))
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(body ?? ''))
    expect(output.statusCode).toBe(200)
  })

  it('honors middleware header replacement and deletion over legacy header metadata', async () => {
    const response = ssrHttpResponseToWebResponse({ statusCode: 200, headers: { 'x-repeated': ['one', 'two'], 'x-delete': ['old'], 'set-cookie': ['a=1', 'b=2'] } })
    response.headers.set('x-repeated', 'replacement')
    response.headers.delete('x-delete')
    response.headers.append('set-cookie', 'c=3')
    const { response: output, headers } = nodeResponse()
    await writeWebResponse({ method: 'GET' }, output, response, new AbortController().signal)
    expect(headers).toEqual({ 'x-repeated': 'replacement', 'set-cookie': ['a=1', 'b=2', 'c=3'] })
  })

  it('preserves status text, ordinary headers and separate Set-Cookie values', async () => {
    const { response: output, headers, chunks } = nodeResponse()
    const headersIn = new Headers({ 'x-custom': 'value' })
    headersIn.append('set-cookie', 'one=1; Path=/; HttpOnly')
    headersIn.append('set-cookie', 'two=2; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/')
    await writeWebResponse({ method: 'GET' }, output, new Response('hello', { status: 201, statusText: 'Created here', headers: headersIn }), new AbortController().signal)
    expect(output.statusCode).toBe(201)
    expect(output.statusMessage).toBe('Created here')
    expect(headers['x-custom']).toBe('value')
    expect(headers['set-cookie']).toEqual(headersIn.getSetCookie())
    expect(Buffer.concat(chunks).toString()).toBe('hello')
  })

  it.each([204, 304, 405])('ends a null-body %s without emitting bytes', async (status) => {
    const { response: output, chunks } = nodeResponse()
    await writeWebResponse({ method: 'GET' }, output, new Response(null, { status }), new AbortController().signal)
    expect(output.statusCode).toBe(status)
    expect(chunks).toEqual([])
    expect(output.writableEnded).toBe(true)
  })

  it('suppresses and cancels HEAD bodies, preserving headers and status', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array([1])) }, cancel })
    const { response: output, headers, chunks } = nodeResponse()
    await writeWebResponse({ method: 'HEAD' }, output, new Response(body, { status: 202, headers: { 'x-head': 'yes' } }), new AbortController().signal)
    expect(output.statusCode).toBe(202)
    expect(headers['x-head']).toBe('yes')
    expect(chunks).toEqual([])
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('applies backpressure instead of collecting an entire response in memory', async () => {
    let pulled = 0
    const callbacks: Array<() => void> = []
    let firstWrite!: () => void
    const started = new Promise<void>((resolve) => { firstWrite = resolve })
    const totalChunks = 256
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      pulled++
      controller.enqueue(new Uint8Array(64 * 1024))
      if (pulled === totalChunks) controller.close()
    } }, { highWaterMark: 0 })
    const { response: output } = nodeResponse((_chunk, callback) => { callbacks.push(callback); firstWrite() })
    const controller = new AbortController()
    const writing = writeWebResponse({ method: 'GET' }, output, new Response(body), controller.signal)
    await started
    // Let the adapters fill their bounded queues while the destination is blocked.
    await new Promise((resolve) => setImmediate(resolve))
    expect(pulled).toBeLessThan(totalChunks)
    controller.abort(new Error('stop test'))
    callbacks.splice(0).forEach((callback) => callback())
    await expect(writing).rejects.toThrow()
    expect(output.destroyed).toBe(true)
  })

  it('cancels an active native response stream when its canonical signal aborts', async () => {
    const cancelled = vi.fn()
    let read!: () => void
    const reading = new Promise<void>((resolve) => { read = resolve })
    const body = new ReadableStream<Uint8Array>({ pull() { read(); return new Promise(() => {}) }, cancel: cancelled })
    const { response: output } = nodeResponse()
    const controller = new AbortController()
    const writing = writeWebResponse({ method: 'GET' }, output, new Response(body), controller.signal)
    await reading
    controller.abort(new Error('client disconnected'))
    await expect(writing).rejects.toThrow()
    expect(cancelled).toHaveBeenCalledOnce()
    expect(output.destroyed).toBe(true)
  })

  it('adapts legacy byte responses and cookies without rewriting legacy storage', async () => {
    const legacy = { statusCode: 202, body: new Uint8Array([0, 255, 127]), headers: { 'set-cookie': ['a=1', 'b=2'] } }
    const response = ssrHttpResponseToWebResponse(legacy)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(legacy.body)
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
    expect(legacy.headers['set-cookie']).toEqual(['a=1', 'b=2'])
  })
})

describe('production asset Response integration', () => {
  it('reuses security, protected templates, viteBase, immutable policy and validators', async () => {
    const root = await temporaryRoot()
    const outside = await temporaryRoot()
    await mkdir(join(root, 'assets'))
    await mkdir(join(root, '.vite'))
    await writeFile(join(root, 'assets/app.js'), 'asset content')
    await writeFile(join(root, 'index.html'), 'private template')
    await writeFile(join(root, '.vite/manifest.json'), 'private manifest')
    await writeFile(join(outside, 'secret.txt'), 'outside')
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'))
    await symlink(join(root, 'index.html'), join(root, 'shell.html'))
    const options = { clientRoot: root, pathname: '/base/assets/app.js', protectedTemplates: ['index.html'], viteBase: '/base/', immutableAssetPaths: new Set(['assets/app.js']) }
    const signal = new AbortController().signal
    const response = (await resolveProductionAssetResponse(options, {}, 'GET', signal))!
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(response.headers.get('content-length')).toBe('13')
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await response.text()).toBe('asset content')
    const etag = response.headers.get('etag')!
    const notModified = await resolveProductionAssetResponse(options, { 'if-none-match': etag }, 'GET', signal)
    expect(notModified?.status).toBe(304)
    expect(notModified?.body).toBeNull()
    const dateResponse = await resolveProductionAssetResponse(options, { 'if-modified-since': response.headers.get('last-modified')! }, 'GET', signal)
    expect(dateResponse?.status).toBe(304)
    const head = await resolveProductionAssetResponse(options, {}, 'HEAD', signal)
    expect(head?.body).toBeNull()
    expect(head?.headers.get('content-length')).toBe('13')
    for (const pathname of ['/base/../secret.txt', '/base/%2e%2e/secret.txt', '/base/.vite/manifest.json', '/base/index.html', '/base/shell.html', '/base/escape.txt', '/base/%ZZ']) {
      expect(await resolveProductionAssetResponse({ ...options, pathname }, {}, 'GET', signal)).toBeNull()
    }
    const mutable = await resolveProductionAssetResponse({ ...options, immutableAssetPaths: new Set() }, {}, 'HEAD', signal)
    expect(mutable?.headers.get('cache-control')).toBe('public, max-age=3600')
  })

  it.each(['ENOENT', 'ENOTDIR'])('returns null when resolution succeeds but open races with %s', async (code) => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'asset.txt'), 'original')
    const openFile = vi.fn(async () => { throw Object.assign(new Error('removed'), { code }) })
    const result = await resolveProductionAssetResponse({ clientRoot: root, pathname: '/asset.txt', protectedTemplates: [] }, {}, 'GET', new AbortController().signal, openFile as typeof open)
    expect(result).toBeNull()
    expect(openFile).toHaveBeenCalledOnce()
  })

  it('returns null and closes an opened representation that is no longer a file', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'asset.txt'), 'original')
    const file = { stat: async () => ({ isFile: () => false }), close: vi.fn(async () => {}) }
    const result = await resolveProductionAssetResponse({ clientRoot: root, pathname: '/asset.txt', protectedTemplates: [] }, {}, 'GET', new AbortController().signal, vi.fn(async () => file) as any)
    expect(result).toBeNull()
    expect(file.close).toHaveBeenCalledOnce()
  })

  it('refreshes size and validators from the opened representation', async () => {
    const root = await temporaryRoot()
    const filename = join(root, 'asset.txt')
    await writeFile(filename, 'old')
    const asset = (await resolveSsrProductionAsset({ clientRoot: root, pathname: '/asset.txt', protectedTemplates: [] }))!
    await writeFile(filename, 'new representation')
    const response = (await productionAssetToWebResponse(asset, {}, 'GET', new AbortController().signal))!
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength('new representation')))
    expect(response.headers.get('etag')).not.toBe(asset.etag)
    expect(await response.text()).toBe('new representation')
  })
})
