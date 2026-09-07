import { describe, expect, it, vi } from 'vitest'
import { defineServerMiddleware } from './defineServerMiddleware'
import { executeServerMiddleware } from './SsrServerMiddlewareRuntime'

const request = () => new Request('https://middleware.test/api')

describe('server middleware execution', () => {
  it.each(['handler', 'middleware'])('makes a %s redirect mutable before outer middleware resumes', async (source) => {
    const decorate = defineServerMiddleware(async (_request, _context, next) => {
      const response = await next()
      response.headers.set('x-decorated', 'yes')
      return response
    })
    const redirect = () => Response.redirect('https://middleware.test/login', 307)
    const chain = source === 'handler' ? [decorate] : [decorate, defineServerMiddleware(redirect)]
    const result = await executeServerMiddleware(chain, request(), { requestId: 'one' }, redirect)
    expect(result.status).toBe(307)
    expect(result.headers.get('location')).toBe('https://middleware.test/login')
    expect(result.headers.get('x-decorated')).toBe('yes')
  })

  it('rewraps the original body without teeing and preserves cancellation and cookies', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 })
    const headers = new Headers()
    headers.append('set-cookie', 'one=1')
    headers.append('set-cookie', 'two=2')
    const original = new Response(body, { status: 201, statusText: 'Custom status', headers })
    const result = await executeServerMiddleware([], request(), { requestId: 'one' }, () => original)
    expect(result.body).toBe(body)
    expect(result.status).toBe(201)
    expect(result.statusText).toBe('Custom status')
    expect(result.headers.getSetCookie()).toEqual(['one=1', 'two=2'])
    await result.body!.cancel('cancel stream')
    expect(cancel).toHaveBeenCalledWith('cancel stream')
  })

  it.each(['handler', 'middleware'])('rejects a status-0 %s Response before transport', async (source) => {
    const invalid = () => Response.error()
    await expect(executeServerMiddleware(source === 'handler' ? [] : [defineServerMiddleware(invalid)], request(), { requestId: 'one' }, invalid))
      .rejects.toThrow('invalid HTTP status 0')
  })

  it('runs in declaration order and unwinds in reverse using the same context and Request', async () => {
    const events: string[] = []
    const context = { requestId: 'one' }
    const input = request()
    const chain = ['global', 'group', 'path', 'method'].map((name) =>
      defineServerMiddleware(async (req, ctx, next) => {
        expect(req).toBe(input)
        expect(ctx).toBe(context)
        events.push(`${name}:before`)
        const response = await next()
        events.push(`${name}:after`)
        response.headers.append('x-order', name)
        return response
      })
    )
    const response = await executeServerMiddleware(chain, input, context, () => { events.push('handler'); return new Response('done') })
    expect(await response.text()).toBe('done')
    expect(events).toEqual(['global:before', 'group:before', 'path:before', 'method:before', 'handler', 'method:after', 'path:after', 'group:after', 'global:after'])
    expect(response.headers.get('x-order')).toBe('method, path, group, global')
  })

  it('short-circuits without executing downstream work and still unwinds outer middleware', async () => {
    const handler = vi.fn(() => new Response('never'))
    const after = vi.fn()
    const chain = [
      defineServerMiddleware(async (_req, _ctx, next) => { const response = await next(); after(response.status); return response }),
      defineServerMiddleware(() => new Response(null, { status: 401 })),
      defineServerMiddleware(handler),
    ]
    expect((await executeServerMiddleware(chain, request(), { requestId: 'one' }, handler)).status).toBe(401)
    expect(after).toHaveBeenCalledWith(401)
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects sequential and concurrent double next() calls deterministically', async () => {
    for (const concurrent of [false, true]) {
      const middleware = defineServerMiddleware(async (_req, _ctx, next) => {
        if (concurrent) return (await Promise.all([next(), next()]))[0]
        await next()
        return next()
      })
      const handler = vi.fn(() => new Response('once'))
      await expect(executeServerMiddleware([middleware], request(), { requestId: 'one' }, handler))
        .rejects.toThrow('Server middleware next() may only be called once.')
      expect(handler).toHaveBeenCalledOnce()
    }
  })

  it.each([undefined, null, {}, 'text', 123])('rejects non-Response middleware and handler returns: %s', async (value) => {
    await expect(executeServerMiddleware([], request(), { requestId: 'one' }, (() => value) as any))
      .rejects.toThrow('must return a native Response instance')
    await expect(executeServerMiddleware([defineServerMiddleware((() => value) as any)], request(), { requestId: 'one' }, () => new Response()))
      .rejects.toThrow('must return a native Response instance')
  })

  it('lets outer middleware catch downstream failures', async () => {
    const middleware = defineServerMiddleware(async (_req, _ctx, next) => {
      try { return await next() } catch { return new Response('recovered', { status: 502 }) }
    })
    const result = await executeServerMiddleware([middleware], request(), { requestId: 'one' }, () => { throw new Error('downstream') })
    expect(result.status).toBe(502)
  })
})
