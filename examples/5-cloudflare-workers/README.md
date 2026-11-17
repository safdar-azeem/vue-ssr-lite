# Cloudflare Workers example

A small `vue-ssr-lite` app deployed to Cloudflare Workers with no handwritten Worker.

```bash
npm install
npm run build      # vue-ssr-lite build --target cloudflare → dist/cloudflare/
npm run preview    # wrangler dev (local workerd)
npx wrangler deploy -c dist/cloudflare/wrangler.json --name <unused-name> --var DEMO_GREETING:hello
```

`wrangler dev` serves on `localhost`, which the framework rejects as a production canonical origin. For local checks use `--local-protocol https` and send a public `Host` header, or set `PUBLIC_URL`.

| Path | Demonstrates |
| --- | --- |
| `/` | SSR page, server-rendered `useFetch` data, hydration, counter, `DEMO_GREETING` var via `getCloudflareEnv()` |
| `/posts/:slug` | Dynamic SSR route, `useSeo`; 404 only for a confirmed missing post, 503 for other API failures (`/posts/simulate-outage`) |
| `/dashboard`, `/dashboard/settings` | Nested SPA routes (`meta.render: 'spa'`) |
| `/old-home` | Global middleware redirect (301) |
| `/api/hello`, `/api/posts/:slug` | GET server routes |
| `/api/echo` | POST/PUT/PATCH/DELETE, 400 on invalid JSON |
| `/api/cookies` | Cookie read + two `Set-Cookie` headers |
| `/isolation?id=…`, `/api/isolation?id=…` | Concurrent request-isolation probes (non-secret ids) |
| `/robots.txt`, `/sitemap.xml` | Generated SEO endpoints using the request origin |
| `/logo.svg`, `/assets/*` | Static assets via Workers Static Assets |

Every response carries `x-demo-middleware: global` from global server middleware.
