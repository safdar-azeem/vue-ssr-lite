# Server API Application

A complete `vue-ssr-lite` example focused on first-party **Server Routes**, **Server Middleware**, and SSR-aware **`useFetch()`**.

This example is intentionally separate from `examples/1-single-app`. The single-app example stays minimal; this one shows how to structure a real application HTTP layer.

## What this example demonstrates

```text
Vue page
  ↓
setContext() → useFetch() / native fetch()
  ↓
vue-ssr-lite managed server
  ↓
serverMiddleware
  ↓
serverRoutes
  ↓
group middleware
  ↓
path middleware
  ↓
method middleware
  ↓
server-only database module
  ↓
native Response
```

Included patterns:

- `defineServer()`
- global `serverMiddleware`
- `defineServerRoutes()`
- multiple server route modules merged into one `serverRoutes` array
- native `Request`, `Response`, `URL`, and `Headers`
- group middleware
- path middleware
- method middleware
- typed `Provides` / `Requires` middleware context
- route params and query parameters
- JSON request bodies
- standard HTTP status codes
- a server-only database/repository module
- `useFetch()` during SSR, hydration, and browser navigation
- application-wide `useFetch()` headers through `setContext()`
- native `fetch()` for POST/PATCH/DELETE mutations
- automatic framework HEAD / OPTIONS / 405 behavior

## Project structure

```text
4-server-api-app/
├── server.ts
├── shared/
│   └── api.ts
├── server/
│   ├── db.ts
│   ├── middleware/
│   │   ├── admin.ts
│   │   ├── auth.ts
│   │   ├── logger.ts
│   │   ├── organization.ts
│   │   ├── product.ts
│   │   └── responseHeaders.ts
│   └── routes/
│       ├── health.ts
│       ├── index.ts
│       ├── organizations.ts
│       └── products.ts
└── src/
    ├── App.vue
    ├── main.ts
    ├── routes.ts
    ├── style.css
    ├── demoAuth.ts
    └── pages/
        ├── HomePage.vue
        ├── OrganizationPage.vue
        ├── ProductPage.vue
        └── ProductsPage.vue
```

## Run

```bash
yarn
yarn dev
```

Open `http://localhost:4211/`.

## API routes

| Method | Path | Middleware | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | global HTTP middleware | Public health-style application route |
| GET | `/api/products` | auth | List/search products |
| POST | `/api/products` | auth | Create product |
| GET | `/api/products/:id` | auth → product | Read product |
| PATCH | `/api/products/:id` | auth → product | Update product |
| DELETE | `/api/products/:id` | auth → product → admin | Delete product |
| GET | `/api/organizations/:organizationId/products/:productId` | auth → organization | Prefix-param example |

`vue-ssr-lite` supplies automatic GET-backed `HEAD`, automatic `OPTIONS`, and `405 Method Not Allowed` where appropriate.

## Global server middleware

```ts
defineServer({
  serverMiddleware: [
    loggerMiddleware,
    responseHeadersMiddleware,
  ],
})
```

Use global server middleware for cross-cutting HTTP behavior such as logging, timing, tracing, CORS, and response headers. It stays separate from Vue navigation `defineMiddleware()`.

## Group middleware

Every route inside `productsRoutes` requires authentication:

```ts
defineServerRoutes({
  prefix: '/api/products',
  middleware: [authMiddleware],
  routes: {
    // ...
  },
})
```

`authMiddleware` provides `context.user` to downstream middleware and handlers.

## Path middleware

`/:id` loads the product once:

```ts
'/:id': {
  middleware: [productMiddleware],
  GET(_request, context) {
    return Response.json({
      product: context.product,
    })
  },
}
```

`productMiddleware` requires the authenticated user and `params.id`, then provides the loaded product.

## Method middleware

Only DELETE requires an administrator:

```ts
DELETE: {
  middleware: [adminMiddleware],
  handler(_request, context) {
    // context.user
    // context.product
    // context.isAdmin
  },
}
```

## Route modules are merged normally

```ts
export const serverRoutes = [
  healthRoutes,
  productsRoutes,
  organizationRoutes,
]
```

Then `server.ts` registers the collection:

```ts
export default defineServer({
  serverMiddleware: [
    loggerMiddleware,
    responseHeadersMiddleware,
  ],
  serverRoutes,
})
```

No controllers, decorators, dependency-injection container, route IDs, or custom request/response wrappers are needed.

## Database layer

`server/db.ts` is an intentionally small in-memory repository so the example runs without PostgreSQL, Prisma, credentials, or infrastructure.

Shared request/response and domain contracts live in `shared/api.ts`, outside both
the browser-only `src/` tree and server-only `server/` tree. Both sides import these
types without reversing their dependency direction.

Server route modules import it normally:

```ts
import { db } from '../db'

const products = await db.products.list()
```

In a real application, replace this file with your normal Prisma/Drizzle/database repository. The routing architecture does not change. The in-memory data resets when the server restarts.

## Authentication used by the example

The example uses two public fixture tokens so every page works without an auth provider:

```text
member-token
admin-token
```

They are demonstration values, not secrets.

The universal `src/main.ts` initializer installs `Bearer member-token` as the default for same-origin `useFetch()` reads:

```ts
import { setContext } from 'vue-ssr-lite'

setContext({
  headers: {
    authorization: 'Bearer member-token',
  },
})
```

Each `setContext()` call replaces the previous stored context. A logout can remove the global headers for future `useFetch()` requests:

```ts
setContext({
  headers: {},
})
```

The pages continue to send `Bearer member-token` explicitly for native POST/PATCH mutations. DELETE explicitly uses `Bearer admin-token`.

A real application should use its normal cookie/session/token architecture instead of hardcoding credentials.

## Reading from Vue with useFetch()

`ProductsPage.vue` uses:

```ts
const { data, pending, error, refresh } =
  useFetch<ProductsResponse, { search?: string }>(
    '/api/products',
    {
      variables: () => ({
        search: search.value.trim() || undefined,
      }),
      fetchPolicy: 'network-only',
      nextFetchPolicy: 'cache-first',
    },
  )
```

A direct `/products` request performs a real same-origin API request during SSR. The rendered HTML contains the result and hydration restores it. Browser navigation uses the local `pending` state.

## Mutations use native fetch()

`useFetch()` is intentionally a read-oriented GET/HEAD composable. `setContext()` applies only to `useFetch()` and does not intercept native requests, so POST/PATCH/DELETE in this example keep their explicit authentication with normal native `fetch()`:

```ts
await fetch('/api/products', {
  method: 'POST',
  headers: {
    ...memberHeaders,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    title: 'Desk clock',
    description: 'Created from the browser.',
    price: 24,
  }),
})

await refresh()
```

The intended model is:

```text
reads       → useFetch() when SSR/hydration state is useful
mutations   → native fetch() or your normal API client
```

Price fields deliberately keep their form state as strings. Create rejects a blank,
non-numeric, or negative price before sending a request. Update treats a blank price
as “leave unchanged” and validates a non-blank value before adding it to the PATCH
body. The API repeats validation because server-side validation remains authoritative.

## Native HTTP primitives

Handlers use normal Web APIs:

```ts
async GET(request, context) {
  const url = new URL(request.url)
  const search = url.searchParams.get('search')

  return Response.json({
    search,
    requestId: context.requestId,
  })
}
```

JSON request bodies use `await request.json()`. No custom body parser is required.
