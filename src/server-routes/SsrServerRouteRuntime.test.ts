import { describe, expect, it, vi } from 'vitest'
import { defineServerRoutes } from './defineServerRoutes'
import { defineServerMiddleware } from './defineServerMiddleware'
import { compileServerRoutes, dispatchServerRoute, matchServerRoute } from './SsrServerRouteRuntime'
import type { ServerRoutesDefinition } from './SsrServerRouteTypes'

const ok = () => new Response('ok')
const group = (routes: ServerRoutesDefinition['routes'], prefix?: string): ServerRoutesDefinition => ({ prefix, routes })
const invoke = (definitions: readonly ServerRoutesDefinition[], pathname: string, method = 'GET') => {
  const match = matchServerRoute(compileServerRoutes(definitions), pathname)
  if (!match) throw new Error('Expected a matching route')
  return dispatchServerRoute(match, new Request(`https://routes.test${pathname}`, { method }), { requestId: 'unit' })
}

describe('server route compilation', () => {
  it('accepts an omitted prefix but rejects an explicitly empty prefix', () => {
    const routes = { '/api': { GET: () => new Response() } }
    expect(compileServerRoutes([{ routes }]).ownedPaths).toEqual(['/api'])
    expect(() => compileServerRoutes([{ prefix: '', routes }]))
      .toThrow("Server route prefix must begin with '/'.")
  })
  it.each([
    [undefined, '/api', '/api'], ['/', '/', '/'],
    ['/api/', '/users/', '/api/users'], ['/org/:orgId', '/products/:productId', '/org/one/products/two'],
  ])('joins prefix %s and path %s', (prefix, child, path) => {
    const table = compileServerRoutes([group({ [child]: { GET: ok } }, prefix)])
    expect(matchServerRoute(table, path)).not.toBeNull()
    expect(matchServerRoute(table, `${path}/`)).not.toBeNull()
  })

  it('keeps static paths case-sensitive and decodes params exactly once', () => {
    const table = compileServerRoutes([group({ '/Users/me': { GET: ok }, '/users/:id': { GET: ok } })])
    expect(matchServerRoute(table, '/Users/me')?.route.pattern).toBe('/Users/me')
    expect(matchServerRoute(table, '/USERS/me')).toBeNull()
    expect(matchServerRoute(table, '/users/a%252Fb')?.params).toEqual({ id: 'a%2Fb' })
    expect(matchServerRoute(table, '/users/a%2Fb')?.params.id).toBe('a/b')
    expect(Object.isFrozen(matchServerRoute(table, '/users/a')?.params)).toBe(true)
  })

  it.each([
    '', 'users', '/users//details', '/users/:', '/users/:id?', '/users/*',
    '/users/**', '/users/:id(\\d+)', '/users/[...slug]', '/users/[[...slug]]',
    '/users/../admin', '/users/./admin', '/users/%2e%2e/admin', '/users#hash', '/users?q=1',
    '/users/:id/:id', '/users/:1id', '/users/a:id', '/users/%GG',
  ])('rejects invalid child path %s', (path) => {
    expect(() => compileServerRoutes([group({ [path]: { GET: ok } })])).toThrow()
  })

  it.each(['', 'api', '/api//v1', '/org/:id?'])('rejects invalid prefix %s', (prefix) => {
    expect(() => compileServerRoutes([group({ '/': { GET: ok } }, prefix)])).toThrow()
  })

  it('rejects duplicate params across the combined prefix and child', () => {
    expect(() => compileServerRoutes([group({ '/items/:id': { GET: ok } }, '/org/:id')]))
      .toThrow('Duplicate server route parameter "id"')
  })

  it('merges disjoint static methods with their own middleware, but rejects duplicate methods', async () => {
    const calls: string[] = []
    const first = defineServerMiddleware((_req, _ctx, next) => { calls.push('first'); return next() })
    const second = defineServerMiddleware((_req, _ctx, next) => { calls.push('second'); return next() })
    const definitions = [
      { middleware: [first], ...group({ '/items': { GET: ok } }) },
      { middleware: [second], ...group({ '/items/': { POST: ok } }) },
    ]
    const table = compileServerRoutes(definitions)
    expect(table.ownedPaths).toEqual(['/items'])
    expect(table.staticRoutes['/items'].allow).toBe('GET, HEAD, POST, OPTIONS')
    await invoke(definitions, '/items', 'POST')
    expect(calls).toEqual(['second'])
    expect(() => compileServerRoutes([...definitions, group({ '/items': { GET: ok } })]))
      .toThrow('Duplicate server route: GET /items')
  })

  it.each([
    ['/users/:id', '/users/:name'], ['/users/:id', '/users/:id/'],
  ])('rejects structurally identical dynamic paths %s and %s, even with disjoint methods', (first, second) => {
    expect(() => compileServerRoutes([group({ [first]: { GET: ok } }), group({ [second]: { POST: ok } })]))
      .toThrow('Duplicate dynamic server route structure')
  })

  it.each([
    ['/healthz', {}], ['/readyz', {}], ['/:id', {}],
    ['/api/:status', { healthPath: '/api/health' }],
    ['/api/:status', { readinessPath: '/api/ready' }],
  ])('rejects static and dynamic control-plane overlaps: %s', (path, controls) => {
    expect(() => compileServerRoutes([group({ [path]: { POST: ok } })], controls))
      .toThrow('reserved framework control path')
  })

  it('rejects exact legacy ownership without calling opaque match predicates', () => {
    const match = vi.fn(() => { throw new Error('Compilation must not call match') })
    const endpoint = { id: 'old', ownedPaths: ['/items/'], match, handle: () => null }
    expect(() => compileServerRoutes([group({ '/items': { POST: ok } })], { endpoints: [endpoint] }))
      .toThrow('Duplicate owned path "/items" declared by both serverRoutes and legacy endpoint "old"')
    expect(() => compileServerRoutes([group({ '/items/:id': { GET: ok } })], { endpoints: [endpoint] })).not.toThrow()
    expect(match).not.toHaveBeenCalled()
  })

  it.each([
    { routes: { '/api': {} } }, { routes: { '/api': { get: ok } } },
    { routes: { '/api': { TRACE: ok } } }, { routes: { '/api': { GET: {} } } },
    { routes: { '/api': { GET: { handler: ok, extra: true } } } },
    { middleware: [null], routes: { '/api': { GET: ok } } },
    { routes: { '/api': { middleware: [null], GET: ok } } },
    { routes: { '/api': { GET: { middleware: [null], handler: ok } } } },
    { prefix: 1, routes: {} }, { prefix: '', routes: { '/api': { GET: ok } } },
    { routes: [] }, { routes: {}, controllers: [] },
  ])('validates untyped runtime configuration %j', (definition) => {
    expect(() => compileServerRoutes([definition as unknown as ServerRoutesDefinition])).toThrow()
  })

  it('snapshots method definitions and middleware arrays for in-flight revisions', async () => {
    const input = group({ '/items': { GET: ok } })
    const table = compileServerRoutes([input])
    ;(input.routes['/items'] as any).GET = () => new Response('changed')
    expect(Object.isFrozen(table)).toBe(true)
    expect(Object.isFrozen(table.staticRoutes['/items'].methods)).toBe(true)
    const match = matchServerRoute(table, '/items')!
    expect(await (await dispatchServerRoute(match, new Request('https://routes.test/items'), { requestId: 'old' })).text()).toBe('ok')
  })
})

describe('path-first method-blind dispatch', () => {
  it('returns static-path 405 instead of trying a dynamic sibling', async () => {
    const dynamic = vi.fn(ok)
    const response = await invoke([group({ '/users/me': { GET: ok }, '/users/:id': { POST: dynamic } })], '/users/me', 'POST')
    expect(response.status).toBe(405)
    expect(response.body).toBeNull()
    expect(response.headers.get('allow')).toBe('GET, HEAD, OPTIONS')
    expect(dynamic).not.toHaveBeenCalled()
  })

  it.each([false, true])('compares specificity left-to-right regardless of registration order (reversed=%s)', async (reverse) => {
    const definitions = [group({ '/a/:type/c': { GET: () => new Response('later-static') } }), group({ '/a/b/:id': { GET: () => new Response('earlier-static') } })]
    if (reverse) definitions.reverse()
    expect(await (await invoke(definitions, '/a/b/c')).text()).toBe('earlier-static')
  })

  it('precomputes canonical Allow independently of declaration order', async () => {
    const response = await invoke([group({ '/all': { DELETE: ok, PATCH: ok, POST: ok, PUT: ok, GET: ok } })], '/all', 'OPTIONS')
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
    expect(response.headers.get('allow')).toBe('GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
  })

  it.each(['OPTIONS', 'POST'])('bypasses group/path/method middleware for automatic %s', async (method) => {
    const run = vi.fn((_req, _ctx, next: () => Promise<Response>) => next())
    const middleware = defineServerMiddleware(run)
    const handler = vi.fn(ok)
    const response = await invoke([{
      middleware: [middleware], routes: { '/items': { middleware: [middleware], GET: { middleware: [middleware], handler } } },
    }], '/items', method)
    expect(response.status).toBe(method === 'OPTIONS' ? 204 : 405)
    expect(run).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('runs explicit OPTIONS and HEAD chains; GET-backed HEAD retains the incoming method', async () => {
    const calls: string[] = []
    const middleware = defineServerMiddleware((req, _ctx, next) => { calls.push(req.method); return next() })
    const definitions = [{ middleware: [middleware], ...group({
      '/explicit': { GET: ok, HEAD: () => new Response(null, { status: 202 }), OPTIONS: () => new Response(null, { status: 200 }) },
      '/implicit': { GET: (request: Request) => new Response(request.method) },
      '/post-only': { POST: ok },
    }) }]
    expect((await invoke(definitions, '/explicit', 'OPTIONS')).status).toBe(200)
    expect((await invoke(definitions, '/explicit', 'HEAD')).status).toBe(202)
    expect(await (await invoke(definitions, '/implicit', 'HEAD')).text()).toBe('HEAD')
    expect((await invoke(definitions, '/post-only', 'HEAD')).status).toBe(405)
    expect(calls).toEqual(['OPTIONS', 'HEAD', 'HEAD'])
  })

  it.each(['/users/%E0%A4%A', '/users/%ZZ', '/unmatched/%'])('rejects malformed percent encoding immediately: %s', (path) => {
    expect(() => matchServerRoute(compileServerRoutes([group({ '/users/:id': { GET: ok } })]), path))
      .toThrow('Malformed percent encoding')
  })

  it('accepts the public identity helper without runtime metadata', () => {
    const definitions = defineServerRoutes({ prefix: '/api', routes: { '/': { GET: ok } } })
    expect(compileServerRoutes([definitions]).ownedPaths).toEqual(['/api'])
  })
})
