import type { SsrEndpointDefinition } from 'vue-ssr-lite/server'

// Public, deterministic fixture data. No third-party service or credentials are needed.
const products = [
  { id: 1, title: 'Pocket notebook', description: 'A compact notebook with plain pages for everyday ideas.', price: 8 },
  { id: 2, title: 'Ceramic mug', description: 'A simple ceramic mug for a quiet coffee break.', price: 14 },
  { id: 3, title: 'Reading lamp', description: 'An adjustable desk lamp with a warm reading light.', price: 32 },
  { id: 4, title: 'Canvas tote', description: 'A reusable canvas bag with room for daily essentials.', price: 18 },
  { id: 5, title: 'Pencil set', description: 'Six wooden pencils for notes, sketches, and plans.', price: 6 },
  { id: 6, title: 'Plant pot', description: 'A small stoneware pot for a desk or windowsill.', price: 12 },
] satisfies Array<{ id: number; title: string; description: string; price: number }>

export const productsEndpoint: SsrEndpointDefinition = {
  id: 'example-products',
  ownedPaths: ['/api/products'],
  match: (request) => request.pathname === '/api/products',
  handle(request) {
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return { statusCode: 405, headers: { ...headers, allow: 'GET, HEAD' }, body: JSON.stringify({ error: 'Method not allowed.' }) }
    }
    const failure = new URLSearchParams(request.search).get('fail') === 'true'
    return {
      statusCode: failure ? 503 : 200,
      headers,
      body: request.method === 'HEAD' ? undefined : JSON.stringify(
        failure ? { error: 'This is the example’s simulated failure.' } : { products }
      ),
    }
  },
}
