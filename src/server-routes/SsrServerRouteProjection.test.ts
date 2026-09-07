import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertNoImportedUniversalConfigMutation,
  projectUniversalRuntimeSource,
} from '../SsrUniversalProjection'

const roots: string[] = []
const exampleRoot = join(dirname(fileURLToPath(import.meta.url)), '../../examples/1-single-app')

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const auditHttpModule = async (source: string): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'ssr-http-projection-audit-'))
  roots.push(root)
  const entry = join(root, 'server.ts')
  const httpModule = join(root, 'http.ts')
  const serverSource = "import './http'\nexport default {}\n"
  await writeFile(entry, serverSource)
  await writeFile(httpModule, source)
  // A universal navigation module imports from the same package as the HTTP
  // helpers. The cross-module audit protects that entire external identity.
  await assertNoImportedUniversalConfigMutation(
    serverSource,
    entry,
    [],
    [],
    [httpModule],
    undefined,
    [
      'external:vue-ssr-lite',
      'external:vue-ssr-lite/server',
      'external:universal-state',
      'external:other-package',
    ]
  )
}

describe('HTTP identity helpers in the universal mutation audit', () => {
  it.each(['server/products.ts', 'server/middleware/logger.ts'])(
    'accepts the single-app example module %s when navigation shares its package import',
    async (file) => {
      const source = await readFile(join(exampleRoot, file), 'utf8')
      await expect(auditHttpModule(source)).resolves.toBeUndefined()
    }
  )

  it.each(['vue-ssr-lite'])(
    'accepts named HTTP helpers from %s without promoting their Node dependencies',
    async (specifier) => {
      await expect(auditHttpModule(`
import { defineServerRoutes, defineServerMiddleware } from '${specifier}'
import { readFileSync } from 'node:fs'
const logger = defineServerMiddleware(async (request, context, next) => {
  const response = await next()
  response.headers.set('x-request-id', context.requestId)
  return response
})
export const products = defineServerRoutes({
  prefix: '/api/products',
  middleware: [logger],
  routes: { '/': { GET() { return new Response(readFileSync('/private/products')) } } },
})
`)).resolves.toBeUndefined()
    }
  )

  it.each([
    {
      name: 'named import aliases',
      declarations: `import { defineServerRoutes as routes, defineServerMiddleware as middleware } from 'vue-ssr-lite'`,
      routes: 'routes',
      middleware: 'middleware',
    },
    {
      name: 'const aliases',
      declarations: `import { defineServerRoutes, defineServerMiddleware } from 'vue-ssr-lite'
const routes = defineServerRoutes
const middleware = defineServerMiddleware`,
      routes: 'routes',
      middleware: 'middleware',
    },
    {
      name: 'namespace imports',
      declarations: `import * as ssr from 'vue-ssr-lite'`,
      routes: 'ssr.defineServerRoutes',
      middleware: 'ssr.defineServerMiddleware',
    },
    {
      name: 'namespace and member aliases',
      declarations: `import * as ssr from 'vue-ssr-lite'
const helpers = ssr
const routes = helpers.defineServerRoutes
const middleware = helpers.defineServerMiddleware`,
      routes: 'routes',
      middleware: 'middleware',
    },
  ])('recognizes $name by lexical binding', async ({ declarations, routes, middleware }) => {
    await expect(auditHttpModule(`
${declarations}
const logger = ${middleware}((request, context, next) => next())
export const products = ${routes}({
  middleware: [logger],
  routes: { '/api/products': { GET() { return Response.json({ products: [] }) } } },
})
`)).resolves.toBeUndefined()
  })

  it.each([
    {
      name: 'a shared route-group middleware argument',
      declaration: 'defineServerRoutes({ middleware, routes: {} })',
    },
    {
      name: 'a shared HTTP middleware handler argument',
      declaration: 'defineServerMiddleware(middleware[0])',
    },
    {
      name: 'a mutation inside a route handler',
      declaration: `defineServerRoutes({ routes: { '/': { GET() {
        middleware.push(() => {})
        return new Response('ok')
      } } } })`,
    },
    {
      name: 'a mutation inside an HTTP middleware callback',
      declaration: `defineServerMiddleware((request, context, next) => {
        middleware.push(() => {})
        return next()
      })`,
    },
    {
      name: 'a shared reference returned from an HTTP callback',
      declaration: 'defineServerMiddleware(() => middleware)',
    },
    {
      name: 'a shared reference passed through a native Response',
      declaration: `defineServerRoutes({ routes: { '/': { GET() {
        return Response.json({ middleware })
      } } } })`,
    },
  ])('still rejects $name', async ({ declaration }) => {
    await expect(auditHttpModule(`
import { defineServerRoutes, defineServerMiddleware } from 'vue-ssr-lite'
import { middleware } from 'universal-state'
export const http = ${declaration}
`)).rejects.toThrow(/universal field "middleware"/)
  })

  it.each([
    `import { arbitrary as defineServerRoutes } from 'vue-ssr-lite'
export const http = defineServerRoutes({ routes: {} })`,
    `import { defineServerRoutes } from 'other-package'
export const http = defineServerRoutes({ routes: {} })`,
    `import { defineServerRoutes } from 'vue-ssr-lite'
import { handler } from 'universal-state'
export const group = defineServerRoutes({ routes: {} })
export function shadowed() {
  const defineServerRoutes = handler
  return defineServerRoutes()
}`,
    `import * as ssr from 'vue-ssr-lite'
import { handler } from 'universal-state'
export const group = ssr.defineServerRoutes({ routes: {} })
export function shadowed() {
  const ssr = { defineServerRoutes: handler }
  return ssr.defineServerRoutes()
}`,
    `import { defineServerMiddleware } from 'vue-ssr-lite'
defineServerMiddleware.property = 'server-only'
export const http = defineServerMiddleware((request, context, next) => next())`,
  ])('does not exempt unknown, shadowed, or mutated helper bindings (%#)', async (source) => {
    await expect(auditHttpModule(source)).rejects.toThrow(
      /escapes through an unsupported call|Configuration is mutated/
    )
  })

  it('keeps HTTP identity calls distinct from application configuration helpers', async () => {
    const source = `
import { defineServerRoutes } from 'vue-ssr-lite'
export default defineServerRoutes({ middleware: [() => {}], routes: {} })
`
    await expect(projectUniversalRuntimeSource(source, '/virtual/products.ts')).resolves.toBeUndefined()
  })
})
