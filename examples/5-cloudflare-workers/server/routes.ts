import { defineServerRoutes } from 'vue-ssr-lite'
import { getCloudflareEnv } from 'vue-ssr-lite/server'

interface DemoEnv {
  /** Non-secret `vars` value from wrangler.json. */
  DEMO_GREETING?: string
}

const posts: Record<string, { title: string; body: string }> = {
  'hello-workers': {
    title: 'Hello, Workers',
    body: 'This post was rendered by Vue on a Cloudflare Worker and hydrated in your browser.',
  },
  'hybrid-routing': {
    title: 'Hybrid routing',
    body: 'Server-rendered pages and client-only dashboard routes share one router.',
  },
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const SAFE_ID = /^[a-z0-9-]{1,40}$/i

export const serverRoutes = [
  defineServerRoutes({
    prefix: '/api',
    routes: {
      '/hello': {
        GET() {
          return Response.json({
            message: 'Hello from a server route',
            runtime: getCloudflareEnv() ? 'cloudflare' : 'node',
            greeting: getCloudflareEnv<DemoEnv>()?.DEMO_GREETING ?? null,
          })
        },
      },
      '/posts/:slug': {
        GET(_request, context) {
          // Deterministic upstream failure for the service-error path (not a missing post).
          if (context.params.slug === 'simulate-outage') {
            return Response.json({ error: 'Post service unavailable' }, { status: 503 })
          }
          const post = posts[context.params.slug]
          return post
            ? Response.json({ slug: context.params.slug, ...post })
            : Response.json({ error: 'Post not found' }, { status: 404 })
        },
      },
      '/echo': {
        async POST(request) {
          let body: unknown
          try { body = await request.json() } catch {
            return Response.json({ error: 'Expected a JSON body' }, { status: 400 })
          }
          return Response.json({ received: body, method: request.method })
        },
        PUT: async (request) => Response.json({ method: 'PUT', received: await request.text() }),
        PATCH: async (request) => Response.json({ method: 'PATCH', received: await request.text() }),
        DELETE: () => new Response(null, { status: 204 }),
      },
      '/cookies': {
        GET(request) {
          const cookie = request.headers.get('cookie') ?? ''
          const visits = Number(/(?:^|;\s*)visits=(\d+)/.exec(cookie)?.[1] ?? 0)
          const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' })
          headers.append('set-cookie', `visits=${visits + 1}; Path=/; HttpOnly; Secure; SameSite=Lax`)
          headers.append('set-cookie', 'theme=light; Path=/; Secure; SameSite=Lax')
          return new Response(JSON.stringify({ visits: visits + 1 }), { headers })
        },
      },
      // Request-isolation probe. Uses only caller-supplied, non-secret ids.
      '/isolation': {
        async GET(request) {
          const id = new URL(request.url).searchParams.get('id') ?? ''
          if (!SAFE_ID.test(id)) return Response.json({ error: 'Invalid id' }, { status: 400 })
          const seen = request.headers.get('x-probe') ?? null
          await delay(5 + Math.floor(Math.random() * 40))
          return Response.json({ id, seen }, { headers: { 'cache-control': 'no-store' } })
        },
      },
    },
  }),
]
