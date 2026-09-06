import { createServer } from 'node:http'
import { defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'
import { productsEndpoint } from '../../../../examples/1-single-app/server/products'
import type { ProductsResponse } from '../../../../examples/1-single-app/src/types/products'
import { renderSsrApplication } from '../../../SsrRenderRuntime'
import type { SsrHttpRequest } from '../../../SsrRuntimeTypes'
import { createTestRenderRequest } from '../../../SsrTestFixtures'
import { useFetch } from '../composables/useFetch'

const request = (path = '/api/products', method = 'GET'): SsrHttpRequest => {
  const url = new URL(path, 'http://products.test')
  return {
    ...createTestRenderRequest(url.host, { url: url.href, protocol: 'http', method }),
    pathname: url.pathname, search: url.search, entryId: 'products',
  }
}

describe('the repository-owned products endpoint', () => {
  it('serves stable public data, an empty HEAD, a repeatable HTTP error and a method boundary', async () => {
    const tools = { signal: new AbortController().signal }
    expect(productsEndpoint.ownedPaths).toEqual(['/api/products'])
    expect(productsEndpoint.match(request())).toBe(true)
    expect(productsEndpoint.match(request('/api/products-extra'))).toBe(false)
    const first = await productsEndpoint.handle(request(), tools)
    const second = await productsEndpoint.handle(request(), tools)
    expect(first).toEqual(second)
    expect(first?.statusCode).toBe(200)
    expect(first?.headers?.['cache-control']).toBe('no-store')
    const body = JSON.parse(first!.body as string) as ProductsResponse
    expect(body.products).toHaveLength(6)
    expect(body.products[0]).toMatchObject({ title: 'Pocket notebook', price: 8 })
    expect(await productsEndpoint.handle(request('/api/products', 'HEAD'), tools)).toMatchObject({ statusCode: 200, body: undefined })
    expect(await productsEndpoint.handle(request('/api/products?fail=true'), tools)).toMatchObject({ statusCode: 503 })
    expect(await productsEndpoint.handle(request('/api/products?fail=true', 'HEAD'), tools)).toMatchObject({ statusCode: 503, body: undefined })
    expect(await productsEndpoint.handle(request('/api/products', 'POST'), tools)).toMatchObject({
      statusCode: 405, headers: { allow: 'GET, HEAD' },
    })
  })

  it('renders the public catalog through one real same-origin HTTP fetch', async () => {
    let requests = 0
    const server = createServer((incoming, outgoing) => {
      requests++
      const input = request(incoming.url, incoming.method)
      void Promise.resolve(productsEndpoint.handle(input, { signal: input.signal! })).then((response) => {
        outgoing.writeHead(response?.statusCode ?? 404, response?.headers)
        outgoing.end(response?.body)
      }, () => { outgoing.writeHead(500); outgoing.end() })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
      })
      const address = server.address() as { port: number }
      const host = `127.0.0.1:${address.port}`
      const root = defineComponent({ setup() {
        const result = useFetch<ProductsResponse>('/api/products', { credentials: 'omit', fetchPolicy: 'cache-first' })
        return () => h('main', result.pending.value ? 'pending' : result.data.value?.products.map((product) => product.title).join(', '))
      } })
      const rendered = await renderSsrApplication({ id: 'local-products', root }, createTestRenderRequest(host, {
        url: `http://${host}/products`, protocol: 'http',
      }))
      expect(rendered.html).toContain('Pocket notebook')
      expect(rendered.html).toContain('Plant pot')
      expect(requests).toBe(1)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
