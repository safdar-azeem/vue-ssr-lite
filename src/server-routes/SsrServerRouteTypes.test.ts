import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// These programs are only evaluated when the owner runs tests. No emit or subprocesses.
const filename = join(dirname(fileURLToPath(import.meta.url)), '__server_route_contract.ts')
const prelude = `
import { defineServer, defineApplication, defineServerRoutes, defineServerMiddleware, defineMiddleware } from '../index'
import type { GlobalServerMiddleware, ServerMiddleware, ServerMiddlewareHandler, ServerRoutesDefinition } from '../index'
type IsAny<T> = 0 extends (1 & T) ? true : false
type User = { id: string; role: 'admin' | 'member' }
type Product = { id: string; title: string }
const logger = defineServerMiddleware(async (request, context, next) => {
  const nativeRequest: Request = request
  const requestId: string = context.requestId
  const response: Response = await next()
  return response
})
const auth = defineServerMiddleware<{ user: User }>((request, context, next) => {
  context.user = { id: 'u1', role: 'admin' }
  return next()
})
const product = defineServerMiddleware<{ product: Product }, { user: User; params: { id: string } }>((request, context, next) => {
  const user: User = context.user
  context.product = { id: context.params.id, title: user.id }
  return next()
})
const admin = defineServerMiddleware<{ isAdmin: true }, { user: User }>((request, context, next) => {
  context.isAdmin = true
  return next()
})
const org = defineServerMiddleware<{ orgId: string }, { params: { orgId: string } }>((request, context, next) => {
  context.orgId = context.params.orgId
  return next()
})
`
const diagnostics = (source: string): string[] => {
  const options: ts.CompilerOptions = {
    strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: ['node', 'vite/client'],
    paths: { 'vue-ssr-lite': [join(dirname(filename), '..', 'index.ts')] },
  }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (path, language, onError, shouldCreateNewSourceFile) =>
    path === filename ? ts.createSourceFile(path, prelude + source, language, true) : original(path, language, onError, shouldCreateNewSourceFile)
  const program = ts.createProgram([filename], options, host)
  return ts.getPreEmitDiagnostics(program).map((diagnostic) =>
    `${diagnostic.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
  )
}

describe('server route public TypeScript contracts', () => {
  it('accepts the canonical server API example against the current public exports', () => {
    expect(diagnostics(`
import server from '../../examples/4-server-api-app/server'
const canonical = server
`)).toEqual([])
  })

  it('supports zero/one/two generics and composes params and middleware without any', () => {
    expect(diagnostics(`
const crossCutting: GlobalServerMiddleware = logger
const zero: ServerMiddleware = logger
const callback: ServerMiddlewareHandler = (_request, _context, next) => next()
const products = defineServerRoutes({
  prefix: '/api/products',
  middleware: [auth, admin],
  routes: {
    '/': { GET(request, context) {
      const user: User = context.user
      const isAdmin: true = context.isAdmin
      const typedContext: false = null! as IsAny<typeof context>
      const typedUser: false = null! as IsAny<typeof context.user>
      return Response.json({ user })
    } },
    '/:id': {
      middleware: [product],
      GET(request, context) {
        const id: string = context.params.id
        const item: Product = context.product
        const typedItem: false = null! as IsAny<typeof context.product>
        return Response.json({ id, item })
      },
      PATCH: { middleware: [logger], handler(request, context) {
        const user: User = context.user
        const item: Product = context.product
        return new Response(item.id)
      } },
    },
  },
})
const methodScoped = defineServerRoutes({
  routes: { '/:id': {
    GET: { middleware: [auth, product, admin], handler(request, context) {
      const id: string = context.params.id
      const item: Product = context.product
      const isAdmin: true = context.isAdmin
      const typedMethod: false = null! as IsAny<typeof context>
      return Response.json({ item, isAdmin })
    } },
  } },
})
const organizations = defineServerRoutes({
  prefix: '/organizations/:orgId', middleware: [org],
  routes: { '/products/:productId': { GET(request, context) {
    const orgId: string = context.params.orgId
    const productId: string = context.params.productId
    const businessOrg: string = context.orgId
    const typedParam: false = null! as IsAny<typeof context.params.orgId>
    return Response.json({ orgId, productId, businessOrg })
  } } },
})
const collection: readonly ServerRoutesDefinition[] = [products, methodScoped, organizations]
defineServer({ serverMiddleware: [logger], serverRoutes: collection })
defineServer({ serverMiddleware: [logger], applications: [defineApplication({ name: 'shop', serverRoutes: collection })] })
const routeKey: keyof typeof products.routes = '/:id'
const prefix: '/api/products' | undefined = products.prefix

const audit = defineServerMiddleware<{ audited: true }, { isAdmin: true }>((request, context, next) => {
  context.audited = true
  return next()
})
const search = defineServerMiddleware<{ query: string }, { user: User; params: { term: string } }>((request, context, next) => {
  context.query = context.params.term
  return next()
})
const completeRouteTable = defineServerRoutes({
  prefix: '/api',
  middleware: [auth],
  routes: {
    '/products/:id': {
      middleware: [admin],
      GET: { middleware: [product], handler(request, context) {
        const nativeRequest: Request = request
        const user: User = context.user
        const isAdmin: true = context.isAdmin
        const item: Product = context.product
        const id: string = context.params.id
        const typedContext: false = null! as IsAny<typeof context>
        return Response.json({ nativeRequest: nativeRequest.url, user, isAdmin, item, id, typedContext })
      } },
      POST: { middleware: [audit], handler(request, context) {
        const user: User = context.user
        const isAdmin: true = context.isAdmin
        const audited: true = context.audited
        const id: string = context.params.id
        const typedContext: false = null! as IsAny<typeof context>
        return Response.json({ user, isAdmin, audited, id, typedContext })
      } },
    },
    '/search/:term': {
      GET: { middleware: [search], handler(request, context) {
        const user: User = context.user
        const query: string = context.query
        const term: string = context.params.term
        const typedContext: false = null! as IsAny<typeof context>
        return Response.json({ user, query, term, typedContext })
      } },
      POST: { handler(request, context) {
        const user: User = context.user
        const term: string = context.params.term
        const typedContext: false = null! as IsAny<typeof context>
        return Response.json({ user, term, typedContext })
      } },
    },
  },
})
const explicitPrefix = defineServerRoutes<'/api'>({
  prefix: '/api', routes: { '/health': { GET: { handler() { return new Response() } } } },
})
const explicitGroup = defineServerRoutes<'/api', readonly [typeof auth]>({
  prefix: '/api', middleware: [auth], routes: { '/me': { GET(request, context) {
    const user: User = context.user
    return Response.json(user)
  } } },
})
type ExplicitPaths = { readonly '/health': { readonly GET: readonly [] } }
const explicitPaths = defineServerRoutes<'/api', readonly [], ExplicitPaths>({
  prefix: '/api', routes: { '/health': { GET: { handler() { return new Response() } } } },
})
const completeCollection: readonly ServerRoutesDefinition[] = [completeRouteTable, explicitPrefix, explicitGroup, explicitPaths]
`)).toEqual([])
  })

  it.each([
    ['provides is optional before assignment', `defineServerMiddleware<{ user: User }>((request, context, next) => { context.user.id; return next() })`],
    ['requires is readable but a new provide remains optional', `defineServerMiddleware<{ product: Product }, { user: User }>((request, context, next) => { context.user.id; context.product.id; return next() })`],
    ['global provides', `defineServer({ serverMiddleware: [auth] })`],
    ['global requires', `defineServer({ serverMiddleware: [admin] })`],
    ['optional global provides cannot widen to empty', `const optional = defineServerMiddleware<{ user?: User }>((r,c,n) => n()); defineServer({ serverMiddleware: [optional] })`],
    ['optional global requires cannot widen to empty', `const optional = defineServerMiddleware<{}, { user?: User }>((r,c,n) => n()); defineServer({ serverMiddleware: [optional] })`],
    ['middleware invariant provides', `const widened: ServerMiddleware<{}, {}> = auth`],
    ['middleware invariant requires', `const widened: ServerMiddleware<{ isAdmin: true }, {}> = admin`],
    ['global params unavailable', `defineServerMiddleware((request, context, next) => { context.params.id; return next() })`],
    ['readonly requestId', `defineServerMiddleware((request, context, next) => { context.requestId = 'changed'; return next() })`],
    ['framework requestId provide', `defineServerMiddleware<{ requestId: string }>(() => new Response())`],
    ['framework params provide', `defineServerMiddleware<{ params: { id: string } }>(() => new Response())`],
    ['readonly required params', `defineServerMiddleware<{}, { params: { id: string } }>((r,c,n) => { c.params.id = 'new'; return n() })`],
    ['no handler return', `defineServerRoutes({ routes: { '/api': { GET() {} } } })`],
    ['no middleware return', `defineServerMiddleware((_request, _context, next) => { next() })`],
    ['non-Response handler', `defineServerRoutes({ routes: { '/api': { GET() { return { ok: true } } } } })`],
    ['unknown method', `defineServerRoutes({ routes: { '/api': { get() { return new Response() } } } })`],
    ['unknown params', `defineServerRoutes({ routes: { '/api/:id': { GET(r,c) { c.params.missing; return new Response() } } } })`],
    ['no params on a static route', `defineServerRoutes({ routes: { '/api': { GET(r,c) { c.params.id; return new Response() } } } })`],
    ['readonly handler params', `defineServerRoutes({ routes: { '/api/:id': { GET(r,c) { c.params.id = 'x'; return new Response() } } } })`],
    ['no handler framework application state', `defineServerRoutes({ routes: { '/api': { GET(r,c) { c.publicConfig; c.domain; c.siteSeo; return new Response() } } } })`],
    ['group ordering', `defineServerRoutes({ middleware: [admin, auth], routes: { '/api': { GET() { return new Response() } } } })`],
    ['group cannot require child params', `defineServerRoutes({ prefix: '/api', middleware: [auth, product], routes: { '/:id': { GET() { return new Response() } } } })`],
    ['path requirements missing', `defineServerRoutes({ routes: { '/api/:id': { middleware: [product], GET() { return new Response() } } } })`],
    ['path ordering', `defineServerRoutes({ routes: { '/api/:id': { middleware: [product, auth], GET() { return new Response() } } } })`],
    ['method ordering', `defineServerRoutes({ routes: { '/api/:id': { GET: { middleware: [product, auth], handler() { return new Response() } } } } })`],
    ['union cannot hide a duplicate provide', `const maybe = Math.random() > 0.5 ? auth : logger; defineServerRoutes({ middleware: [auth, maybe], routes: { '/api': { GET() { return new Response() } } } })`],
    ['union cannot hide missing requirements', `const maybe = Math.random() > 0.5 ? auth : logger; defineServerRoutes({ middleware: [maybe, admin], routes: { '/api': { GET() { return new Response() } } } })`],
    ['duplicate group provides', `defineServerRoutes({ middleware: [auth, auth], routes: { '/api': { GET() { return new Response() } } } })`],
    ['duplicate path provides', `defineServerRoutes({ middleware: [auth], routes: { '/api': { middleware: [auth], GET() { return new Response() } } } })`],
    ['duplicate method provides', `defineServerRoutes({ middleware: [auth], routes: { '/api': { GET: { middleware: [auth], handler() { return new Response() } } } } })`],
    ['method state cannot leak to sibling', `defineServerRoutes({ routes: { '/api': { GET: { middleware: [auth], handler(r,c) { return new Response(c.user.id) } }, POST(r,c) { return new Response(c.user.id) } } } })`],
    ['Vue middleware stays separate', `defineServer({ serverMiddleware: [defineMiddleware(() => {})] })`],
    ['application global middleware forbidden', `defineApplication({ name: 'shop', serverMiddleware: [logger] })`],
    ['top-level multi-app serverRoutes forbidden', `defineServer({ applications: [defineApplication({ name: 'shop' })], serverRoutes: [] })`],
  ])('rejects %s', (_name, source) => {
    expect(diagnostics(source).some((message) => message.startsWith(filename))).toBe(true)
  })
})
