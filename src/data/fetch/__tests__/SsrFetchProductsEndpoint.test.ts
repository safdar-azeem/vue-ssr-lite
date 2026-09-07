import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'
import { productsRoutes } from '../../../../examples/1-single-app/server/products'
import type { ProductsResponse } from '../../../../examples/1-single-app/src/types/products'
import { renderSsrApplication } from '../../../SsrRenderRuntime'
import { createTestRenderRequest } from '../../../SsrTestFixtures'
import { defineServerMiddleware } from '../../../server-routes/defineServerMiddleware'
import { createSsrManagedServer, type SsrManagedServer } from '../../../server/SsrServerRuntime'
import { useFetch } from '../composables/useFetch'

const withProductsServer = async (run: (origin: string, count: () => number) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), 'ssr-fetch-products-'))
  let server: SsrManagedServer | undefined
  let requests = 0
  try {
    await writeFile(join(root, 'index.html'), '<html><body><div id="app"></div></body></html>')
    server = await createSsrManagedServer({ production: false, root, loadRuntime: async () => ({
      render: 'spa', server: { port: 0, host: '127.0.0.1' },
      serverRoutes: [productsRoutes],
      serverMiddleware: [defineServerMiddleware((_request, _context, next) => { requests++; return next() })],
    }) })
    await server.listen()
    await run(`http://127.0.0.1:${server.address().port}`, () => requests)
  } finally {
    await server?.close()
    await rm(root, { recursive: true, force: true })
  }
}

describe('the repository-owned products server route', () => {
  it('serves stable public data with Core HEAD, OPTIONS and 405 semantics', async () => {
    await withProductsServer(async (origin) => {
      const response = await fetch(`${origin}/api/products`)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const body = await response.json() as ProductsResponse
      expect(body.products).toHaveLength(6)
      expect(body.products[0]).toMatchObject({ title: 'Pocket notebook', price: 8 })
      expect(await (await fetch(`${origin}/api/products`)).json()).toEqual(body)
      const head = await fetch(`${origin}/api/products`, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
      expect((await fetch(`${origin}/api/products?fail=true`)).status).toBe(503)
      const failedHead = await fetch(`${origin}/api/products?fail=true`, { method: 'HEAD' })
      expect(failedHead.status).toBe(503)
      expect(await failedHead.text()).toBe('')
      const method = await fetch(`${origin}/api/products`, { method: 'POST' })
      expect(method.status).toBe(405)
      expect(method.headers.get('allow')).toBe('GET, HEAD, OPTIONS')
      expect(await method.text()).toBe('')
      const options = await fetch(`${origin}/api/products`, { method: 'OPTIONS' })
      expect(options.status).toBe(204)
      expect(options.headers.get('allow')).toBe('GET, HEAD, OPTIONS')
    })
  })

  it('renders the catalog through one real same-origin useFetch request to the managed server', async () => {
    await withProductsServer(async (origin, count) => {
      const root = defineComponent({ setup() {
        const result = useFetch<ProductsResponse>('/api/products', { credentials: 'omit', fetchPolicy: 'cache-first' })
        return () => h('main', result.pending.value ? 'pending' : result.data.value?.products.map((product) => product.title).join(', '))
      } })
      const rendered = await renderSsrApplication({ id: 'local-products', root }, createTestRenderRequest(new URL(origin).host, {
        url: `${origin}/products`, protocol: 'http',
      }))
      expect(rendered.html).toContain('Pocket notebook')
      expect(rendered.html).toContain('Plant pot')
      expect(count()).toBe(1)
    })
  })
})
