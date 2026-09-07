import { defineServerRoutes } from 'vue-ssr-lite'

// Public, deterministic fixture data. No third-party service or credentials are needed.
const products = [
  { id: 1, title: 'Pocket notebook', description: 'A compact notebook with plain pages for everyday ideas.', price: 8 },
  { id: 2, title: 'Ceramic mug', description: 'A simple ceramic mug for a quiet coffee break.', price: 14 },
  { id: 3, title: 'Reading lamp', description: 'An adjustable desk lamp with a warm reading light.', price: 32 },
  { id: 4, title: 'Canvas tote', description: 'A reusable canvas bag with room for daily essentials.', price: 18 },
  { id: 5, title: 'Pencil set', description: 'Six wooden pencils for notes, sketches, and plans.', price: 6 },
  { id: 6, title: 'Plant pot', description: 'A small stoneware pot for a desk or windowsill.', price: 12 },
] satisfies Array<{ id: number; title: string; description: string; price: number }>

export const productsRoutes = defineServerRoutes({
  prefix: '/api/products',
  routes: {
    '/': {
      GET(request) {
        const failure = new URL(request.url).searchParams.get('fail') === 'true'
        return Response.json(failure ? { error: 'This is the example’s simulated failure.' } : { products }, {
          status: failure ? 503 : 200,
          headers: { 'cache-control': 'no-store' },
        })
      },
    },
  },
})
