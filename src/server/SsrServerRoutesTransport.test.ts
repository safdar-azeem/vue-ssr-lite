import { Agent, createServer, request as httpRequest, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defineServer, defineServerMiddleware, defineServerRoutes, type ServerRoutesDefinition } from '../index'
import { createSsrManagedServer, type SsrManagedServer } from './SsrServerRuntime'

let managed: SsrManagedServer | undefined
let root: string | undefined
const agents: Agent[] = []
const upstreamServers: Server[] = []
afterEach(async () => {
  agents.splice(0).forEach((agent) => agent.destroy())
  await Promise.all(upstreamServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => error ? reject(error) : resolve())
  })))
  await managed?.close()
  if (root) await rm(root, { recursive: true, force: true })
  managed = undefined; root = undefined
})

const startUpstream = async (handler: RequestListener): Promise<string> => {
  const server = createServer(handler)
  upstreamServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected an upstream TCP address')
  return `http://127.0.0.1:${address.port}`
}

const start = async (routes: ServerRoutesDefinition = defineServerRoutes({ routes: {
  '/api': { GET: () => new Response('api') },
  '/early': { POST: () => new Response('early') },
  '/echo/json': { async POST(request) { return Response.json(await request.json()) } },
  '/echo/text': { async POST(request) { return new Response(await request.text()) } },
  '/echo/form': { async POST(request) { return Response.json(Object.fromEntries(await request.formData())) } },
} }), requestTimeoutMs = 3_000) => {
  root = await mkdtemp(join(tmpdir(), 'ssr-routes-http-'))
  await mkdir(join(root, 'dist/client'), { recursive: true })
  const template = '<html><body><div id="app"></div></body></html>'
  await writeFile(join(root, 'index.html'), template)
  await writeFile(join(root, 'dist/client/index.html'), template)
  await writeFile(join(root, 'dist/client/asset.txt'), 'asset body')
  managed = await createSsrManagedServer({ production: true, root, loadRuntime: async () => defineServer({
    render: 'spa', host: 'routes.test', server: { port: 0, host: '127.0.0.1', requestTimeoutMs },
    serverMiddleware: [defineServerMiddleware(async (request, _context, next) => {
      if (new URL(request.url).pathname === '/auth') return new Response(null, { status: 401 })
      const response = await next()
      response.headers.set('x-global', 'yes')
      return response
    }), defineServerMiddleware((request, _context, next) => {
      if (new URL(request.url).pathname === '/middleware-redirect') return Response.redirect('https://routes.test/target', 307)
      return next()
    })],
    serverRoutes: [routes],
  }) })
  await managed.listen()
  return managed.address().port
}

const send = (port: number, path: string, options: { method?: string; body?: string; host?: string; headers?: Record<string, string>; agent?: Agent } = {}) =>
  new Promise<{ status: number; statusText?: string; body: string; headers: IncomingHttpHeaders; localPort?: number }>((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', agent: options.agent,
      headers: { host: options.host ?? 'routes.test', accept: 'application/json', ...(options.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(options.body)) }), ...options.headers },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.once('end', () => resolve({ status: response.statusCode!, statusText: response.statusMessage, headers: response.headers, body: Buffer.concat(chunks).toString(), localPort: request.socket?.localPort }))
      response.once('error', reject)
    })
    request.once('error', reject)
    request.end(options.body)
  })

describe('managed server routes over Node HTTP', () => {
  it('returns route-owned 405 or deliberate fallback 404 for TRACE without native middleware', async () => {
    const port = await start()
    const agent = new Agent({ keepAlive: true, maxSockets: 1 }); agents.push(agent)
    const matched = await send(port, '/api', { method: 'TRACE', body: 'unread', agent })
    expect(matched.status).toBe(405)
    expect(matched.headers.allow).toBe('GET, HEAD, OPTIONS')
    expect(matched.headers['x-global']).toBeUndefined()
    const unmatched = await send(port, '/missing', { method: 'TRACE', agent })
    expect(unmatched.status).toBe(404)
    expect(unmatched.headers.allow).toBeUndefined()
    expect(unmatched.headers['x-global']).toBeUndefined()
    const next = await send(port, '/api', { agent })
    expect(next.status).toBe(200)
    expect(next.localPort).toBe(matched.localPort)
  })

  it('decorates native route and middleware redirects and converts Response.error to a framework 500', async () => {
    const port = await start(defineServerRoutes({ routes: {
      '/redirect': { GET: () => Response.redirect('https://routes.test/target', 308) },
      '/invalid': { GET: () => Response.error() },
      '/ok': { GET: () => new Response('ok') },
    } }))
    for (const [path, status] of [['/redirect', 308], ['/middleware-redirect', 307]] as const) {
      const result = await send(port, path)
      expect(result.status).toBe(status)
      expect(result.headers.location).toBe('https://routes.test/target')
      expect(result.headers['x-global']).toBe('yes')
    }
    const agent = new Agent({ keepAlive: true, maxSockets: 1 }); agents.push(agent)
    const invalid = await send(port, '/invalid', { agent })
    expect(invalid.status).toBe(500)
    const next = await send(port, '/ok', { agent })
    expect(next.status).toBe(200)
    expect(next.localPort).toBe(invalid.localPort)
  })

  it('decorates an immutable fetch response without losing its streamed body or cookies', async () => {
    let port = 0
    port = await start(defineServerRoutes({ routes: {
      '/upstream': { GET: () => new Response('proxied', { status: 202, headers: { 'set-cookie': 'upstream=1' } }) },
      '/proxy': { GET: () => fetch(`http://127.0.0.1:${port}/upstream`, { headers: { host: 'routes.test' } }) },
    } }))
    const result = await send(port, '/proxy')
    expect(result.status).toBe(202)
    expect(result.body).toBe('proxied')
    expect(result.headers['x-global']).toBe('yes')
    expect(result.headers['set-cookie']).toEqual(['upstream=1'])
  })

  it.each([
    { encoding: 'gzip', compress: gzipSync },
    { encoding: 'deflate', compress: deflateSync },
    { encoding: 'br', compress: brotliCompressSync },
  ])('forwards decoded $encoding fetch bodies with safe downstream headers and reusable connections', async ({ encoding, compress }) => {
    const logical = 'A complete logical upstream representation.\n'.repeat(4096)
    const compressed = compress(Buffer.from(logical))
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(203, 'Upstream representation', {
        'content-encoding': encoding, 'content-length': String(compressed.length),
        'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=60',
        etag: 'W/"logical-version"', 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
        'set-cookie': ['one=1', 'two=2'], 'x-application': 'preserved',
        connection: 'keep-alive, x-upstream-only', 'x-upstream-only': 'private-connection-state',
        'keep-alive': 'timeout=1234', 'proxy-connection': 'keep-alive', te: 'trailers', upgrade: 'h2c',
      })
      response.end(compressed)
    })
    let fetchedBody: ReadableStream<Uint8Array> | null = null
    const port = await start(defineServerRoutes({
      middleware: [defineServerMiddleware(async (_request, _context, next) => {
        const response = await next()
        expect(response.body).toBe(fetchedBody)
        expect(response.bodyUsed).toBe(false)
        expect(response.headers.has('content-encoding')).toBe(false)
        // A middleware may rewrap the same stream; its fetch provenance survives.
        return new Response(response.body, response)
      })],
      routes: { '/proxy': { async GET(request) {
        const response = await fetch(upstream, { signal: request.signal })
        fetchedBody = response.body
        return response
      } } },
    }))
    const agent = new Agent({ keepAlive: true, maxSockets: 1 }); agents.push(agent)
    const first = await send(port, '/proxy', { agent })
    expect(first.status).toBe(203)
    expect(first.statusText).toBe('Upstream representation')
    expect(first.body).toBe(logical)
    expect(first.headers['x-global']).toBe('yes')
    expect(first.headers['content-encoding']).toBeUndefined()
    expect(first.headers['content-length']).toBeUndefined()
    expect(first.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(first.headers['cache-control']).toBe('public, max-age=60')
    expect(first.headers.etag).toBe('W/"logical-version"')
    expect(first.headers['last-modified']).toBe('Wed, 21 Oct 2015 07:28:00 GMT')
    expect(first.headers['set-cookie']).toEqual(['one=1', 'two=2'])
    expect(first.headers['x-application']).toBe('preserved')
    for (const name of ['x-upstream-only', 'proxy-connection', 'te', 'trailer', 'upgrade']) expect(first.headers[name]).toBeUndefined()
    // Node may generate its own Connection/Keep-Alive and transfer framing.
    expect(first.headers.connection).not.toContain('x-upstream-only')
    expect(first.headers['keep-alive']).not.toBe('timeout=1234')
    expect(first.localPort).toEqual(expect.any(Number))
    const second = await send(port, '/proxy', { agent })
    expect(second.body).toBe(logical)
    expect(second.localPort).toBe(first.localPort)
  })

  it('rejects a decoded fetched 206 before committing encoded range metadata or body bytes', async () => {
    const logical = 'decoded partial response that must not reach the client'
    const compressed = gzipSync(logical)
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(206, 'Partial Content', {
        'content-encoding': 'gzip',
        'content-length': String(compressed.length),
        'content-range': `bytes 0-${compressed.length - 1}/${compressed.length * 2}`,
        'content-type': 'text/plain',
      })
      response.end(compressed)
    })
    const port = await start(defineServerRoutes({ routes: {
      '/proxy': { GET: (request) => fetch(upstream, { signal: request.signal }) },
      '/ok': { GET: () => new Response('ok') },
    } }))
    const agent = new Agent({ keepAlive: true, maxSockets: 1 }); agents.push(agent)
    const partial = await send(port, '/proxy', { agent })
    expect(partial.status).toBe(500)
    expect(partial.headers['content-range']).toBeUndefined()
    expect(partial.headers['content-encoding']).toBeUndefined()
    expect(partial.body).not.toContain(logical)
    const next = await send(port, '/ok', { agent })
    expect(next.status).toBe(200)
    expect(next.body).toBe('ok')
    expect(next.localPort).toBe(partial.localPort)
  })

  it('removes upstream encoded integrity fields while retaining middleware replacements for decoded bytes', async () => {
    const compressed = gzipSync('decoded representation')
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, {
        'content-encoding': 'gzip',
        'content-length': String(compressed.length),
        'content-md5': 'encoded-md5',
        'content-digest': 'sha-256=:encoded-content:',
        'repr-digest': 'sha-256=:encoded-representation:',
        digest: 'sha-256=encoded-digest',
      })
      response.end(compressed)
    })
    const replaceIntegrity = defineServerMiddleware(async (_request, _context, next) => {
      const response = await next()
      response.headers.set('content-digest', 'sha-256=:decoded-content:')
      response.headers.set('repr-digest', 'sha-256=:decoded-representation:')
      return response
    })
    const proxy = (request: Request) => fetch(upstream, { signal: request.signal })
    const port = await start(defineServerRoutes({ routes: {
      '/proxy': { GET: proxy },
      '/proxy-replaced': { GET: { middleware: [replaceIntegrity], handler: proxy } },
    } }))
    const unchanged = await send(port, '/proxy')
    expect(unchanged.status).toBe(200)
    expect(unchanged.body).toBe('decoded representation')
    for (const name of ['content-md5', 'content-digest', 'repr-digest', 'digest']) {
      expect(unchanged.headers[name]).toBeUndefined()
    }

    const replaced = await send(port, '/proxy-replaced')
    expect(replaced.status).toBe(200)
    expect(replaced.body).toBe('decoded representation')
    expect(replaced.headers['content-md5']).toBeUndefined()
    expect(replaced.headers.digest).toBeUndefined()
    expect(replaced.headers['content-digest']).toBe('sha-256=:decoded-content:')
    expect(replaced.headers['repr-digest']).toBe('sha-256=:decoded-representation:')
  })

  it('delivers decoded gzip bytes before the upstream finishes instead of buffering the whole body', async () => {
    const firstText = 'first logical chunk\n'.repeat(256)
    const lastText = 'last logical chunk\n'.repeat(256)
    const firstMember = gzipSync(firstText)
    const lastMember = gzipSync(lastText)
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, {
        'content-encoding': 'gzip', 'content-length': String(firstMember.length + lastMember.length),
        etag: '"compressed-byte-version"',
      })
      response.write(firstMember)
      void released.then(() => response.end(lastMember))
    })
    const port = await start(defineServerRoutes({ routes: {
      '/proxy': { GET: (request) => fetch(upstream, { signal: request.signal }) },
    } }))
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const request = httpRequest({ hostname: '127.0.0.1', port, path: '/proxy', headers: { host: 'routes.test' } }, (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk) => { chunks.push(Buffer.from(chunk)); release() })
          response.once('error', reject)
          response.once('end', () => {
            try {
              expect(response.statusCode).toBe(200)
              expect(response.headers.etag).toBeUndefined()
              expect(response.headers['content-encoding']).toBeUndefined()
              expect(response.headers['content-length']).toBeUndefined()
              expect(response.headers['x-global']).toBe('yes')
              resolve(Buffer.concat(chunks).toString())
            } catch (error) { reject(error) }
          })
        })
        request.once('error', reject)
        request.end()
      })
      expect(body).toBe(firstText + lastText)
    } finally { release() }
  })

  it('removes upstream trailers and rechecks connection/framing headers added while middleware unwinds', async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, {
        connection: 'keep-alive, x-upstream', 'x-upstream': 'connection-only',
        trailer: 'x-trailer', etag: '"unchanged-bytes"', 'content-type': 'text/plain',
      })
      response.write('first ')
      response.addTrailers({ 'x-trailer': 'trailer-value' })
      response.end('last')
    })
    const port = await start(defineServerRoutes({
      middleware: [defineServerMiddleware(async (_request, _context, next) => {
        const response = await next()
        response.headers.set('connection', 'x-late-only')
        response.headers.set('x-late-only', 'connection-only')
        response.headers.set('transfer-encoding', 'gzip')
        response.headers.set('trailer', 'x-late-trailer')
        return response
      })],
      routes: { '/proxy': { GET: (request) => fetch(upstream, { signal: request.signal }) } },
    }))
    const result = await send(port, '/proxy')
    expect(result.status).toBe(200)
    expect(result.body).toBe('first last')
    expect(result.headers.etag).toBe('"unchanged-bytes"')
    expect(result.headers['x-global']).toBe('yes')
    expect(result.headers['transfer-encoding']).toBe('chunked')
    for (const name of ['x-upstream', 'x-late-only', 'trailer']) expect(result.headers[name]).toBeUndefined()
    expect(result.headers.connection).not.toContain('x-late-only')
  })

  it('retains representation headers for a fetched HEAD response with no decoded body', async () => {
    const compressed = gzipSync('logical body')
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(compressed.length), etag: '"encoded-head"' })
      response.end()
    })
    const port = await start(defineServerRoutes({ routes: {
      '/proxy': { HEAD: (request) => fetch(upstream, { method: 'HEAD', signal: request.signal }) },
    } }))
    const result = await send(port, '/proxy', { method: 'HEAD' })
    expect(result.status).toBe(200)
    expect(result.body).toBe('')
    expect(result.headers['content-encoding']).toBe('gzip')
    expect(result.headers['content-length']).toBe(String(compressed.length))
    expect(result.headers.etag).toBe('"encoded-head"')
  })

  it.each([
    { type: 'application/x-www-form-urlencoded', body: 'name=Ada+Lovelace&note=a%2Bb' },
    { type: 'multipart/form-data; boundary=ssr-form', body: '--ssr-form\r\nContent-Disposition: form-data; name="name"\r\n\r\nAda Lovelace\r\n--ssr-form\r\nContent-Disposition: form-data; name="note"\r\n\r\na+b\r\n--ssr-form--\r\n' },
  ])('parses native formData over HTTP: $type', async ({ type, body }) => {
    const port = await start()
    const result = await send(port, '/echo/form', { method: 'POST', body, headers: { 'content-type': type } })
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({ name: 'Ada Lovelace', note: 'a+b' })
  })

  it('parses native JSON and text request bodies over real HTTP', async () => {
    const port = await start()
    const json = await send(port, '/echo/json', { method: 'POST', body: '{"value":42}', headers: { 'content-type': 'application/json' } })
    expect(json.status).toBe(200)
    expect(JSON.parse(json.body)).toEqual({ value: 42 })
    const text = await send(port, '/echo/text', { method: 'POST', body: 'native streamed payload' })
    expect(text.body).toBe('native streamed payload')
  })

  it.each([
    ['/healthz', 'POST', 200, 'routes.test'], ['/readyz', 'POST', 200, 'routes.test'],
    ['/.vite/manifest.json', 'POST', 404, 'routes.test'],
    ['/api', 'POST', 400, 'bad host'], ['/api', 'POST', 421, 'unknown.test'],
    ['/auth', 'POST', 401, 'routes.test'], ['/api', 'POST', 405, 'routes.test'],
    ['/early', 'POST', 200, 'routes.test'], ['/asset.txt', 'GET', 200, 'routes.test'],
    ['/missing', 'POST', 404, 'routes.test'],
  ])('drains unread bodies after %s %s (%s), preserving the keep-alive socket', async (path, method, status, host) => {
    const port = await start()
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    agents.push(agent)
    const first = await send(port, path, { method, host, body: 'x'.repeat(256 * 1024), agent })
    expect(first.status).toBe(status)
    const next = await send(port, '/api', { agent })
    expect(next.status).toBe(200)
    expect(next.body).toBe('api')
    expect(next.localPort).toBe(first.localPort)
  })

  it('exposes asset 200 and 304 Responses to middleware and drains validator request bodies', async () => {
    const port = await start()
    const agent = new Agent({ keepAlive: true, maxSockets: 1 }); agents.push(agent)
    const asset = await send(port, '/asset.txt', { agent })
    expect(asset.headers['x-global']).toBe('yes')
    expect(asset.headers['content-length']).toBe(String(Buffer.byteLength('asset body')))
    expect(asset.headers.etag).toBeDefined()
    expect(asset.body).toBe('asset body')
    const cached = await send(port, '/asset.txt', { agent, body: 'unread', headers: { 'if-none-match': asset.headers.etag! } })
    expect(cached.status).toBe(304)
    expect(cached.body).toBe('')
    expect(cached.headers['x-global']).toBe('yes')
    const next = await send(port, '/api', { agent })
    expect(next.localPort).toBe(asset.localPort)
  })

  it('suppresses explicit and GET-backed HEAD bytes and keeps the original method', async () => {
    const methods: string[] = []
    const routes = defineServerRoutes({ routes: {
      '/implicit': { GET(request) { methods.push(request.method); return new Response('hidden', { headers: { 'x-head': 'implicit' } }) } },
      '/explicit': { GET: () => new Response('GET'), HEAD(request) { methods.push(request.method); return new Response('hidden', { status: 202, headers: { 'x-head': 'explicit' } }) } },
    } })
    const port = await start(routes)
    const implicit = await send(port, '/implicit', { method: 'HEAD' })
    const explicit = await send(port, '/explicit', { method: 'HEAD' })
    expect(implicit).toMatchObject({ status: 200, body: '', headers: { 'x-head': 'implicit' } })
    expect(explicit).toMatchObject({ status: 202, body: '', headers: { 'x-head': 'explicit' } })
    expect(methods).toEqual(['HEAD', 'HEAD'])
  })

  it('streams native bodies and emits multiple cookies and custom status text over HTTP', async () => {
    const routes = defineServerRoutes({ routes: { '/stream': { GET() {
      const headers = new Headers()
      headers.append('set-cookie', 'first=1; Path=/')
      headers.append('set-cookie', 'second=2; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/')
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('first'))
        queueMicrotask(() => { controller.enqueue(new TextEncoder().encode('second')); controller.close() })
      } })
      return new Response(body, { status: 201, statusText: 'Stream created', headers })
    } } } })
    const port = await start(routes)
    const response = await send(port, '/stream')
    expect(response.status).toBe(201)
    expect(response.statusText).toBe('Stream created')
    expect(response.body).toBe('firstsecond')
    expect(response.headers['set-cookie']).toEqual([
      'first=1; Path=/', 'second=2; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/',
    ])
  })

  it('drains an unread GET body after rendering a SPA document', async () => {
    const port = await start()
    const agent = new Agent({ keepAlive: true, maxSockets: 1 }); agents.push(agent)
    const page = await send(port, '/page?preview=1', { agent, body: 'unread page body', headers: { accept: 'text/html' } })
    expect(page.status).toBe(200)
    expect(page.body).toContain('<div id="app">')
    const next = await send(port, '/api', { agent })
    expect(next.status).toBe(200)
    expect(next.localPort).toBe(page.localPort)
  })

  it('aborts the canonical native Request signal when the client disconnects', async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    let cancelled!: (value: boolean) => void
    const aborted = new Promise<boolean>((resolve) => { cancelled = resolve })
    const routes = defineServerRoutes({ routes: { '/abort': { async POST(request) {
      entered()
      await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => { cancelled(request.signal.aborted); resolve() }, { once: true }))
      return new Response('late')
    } } } })
    const port = await start(routes)
    const request = httpRequest({ hostname: '127.0.0.1', port, path: '/abort', method: 'POST', headers: { host: 'routes.test', 'content-length': '100000' } })
    request.on('error', () => {})
    request.write('partial')
    await started
    request.destroy()
    expect(await aborted).toBe(true)
  })

  it('uses the existing request timeout and centralized error response for pending handlers', async () => {
    const routes = defineServerRoutes({ routes: { '/wait': { GET: () => new Promise<Response>(() => {}) } } })
    const port = await start(routes, 30)
    expect((await send(port, '/wait')).status).toBe(504)
  })
})
