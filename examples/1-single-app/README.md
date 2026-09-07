# Simple Single Application

`server.ts` is the only server configuration file. `/src/main.ts` and `/src/App.vue` are used automatically. No `defineApplication()` is required.

This example demonstrates:

- SSR
- Pinia installed per app/request in `main.ts`
- global `App.vue`
- routes from `src/routes.ts`
- global SEO, route SEO, and dynamic `useSeo()`
- sitemap and robots configured on `defineServer({ seo })`

```ts
import { defineServer } from 'vue-ssr-lite'

export default defineServer({
  render: 'ssr',
  server: { port: 4211 },
})
```

## SSR Data Fetching

The `/products` page uses `useFetch()` against the deterministic, same-origin
`/api/products` server route registered in `server.ts`. Its six products are defined
in `server/products.ts`; the example needs no external API, images, database,
CORS configuration, or service credentials.

A direct `/products` load starts one native HTTP request during SSR, even though
the hook is not awaited. The HTML contains the products. Hydration restores
that state without another request. Browser navigation renders local pending
UI while fetching; `RouterView` does not own the network loading interval.

The catalog is public, so the hook uses `credentials: 'omit'`. Its anonymous SSR
cache can safely be adopted by the browser. `fetchPolicy: 'cache-first'` lets
later page mounts reuse that successful application cache. **Refresh products**
bypasses settled cache and makes one request (or joins an existing one).
The server route uses HTTP `Cache-Control: no-store`, so this demonstrates the
useFetch application cache independently of the browser's HTTP cache.

**Simulate an error** switches to `/api/products?fail=true`, which always returns
503. The page displays the HTTP error without retrying. Turn it off to return
to the successful catalog identity. This gives SSR, hydration, pending, refresh,
cache reuse, and HTTP errors a repository-owned demonstration surface.

The route uses `defineServerRoutes()` with a native `Request` and `Response.json()`.
Core supplies GET-backed HEAD, automatic OPTIONS, and 405 responses with `Allow`.
`serverRoutes` is server-only; the page calls it over HTTP through `useFetch`.
The example’s `defineMiddleware()` logger remains Vue navigation middleware.

`server/middleware/logger.ts` separately uses `defineServerMiddleware()` to log
application HTTP responses, including the products API and HTML pages. It is
registered on `serverMiddleware`; health/readiness and Vite-owned requests bypass it.
