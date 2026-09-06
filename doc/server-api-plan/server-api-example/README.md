# vue-ssr-lite Server Routes Example v8

A clean example of the proposed public HTTP API blueprint for `vue-ssr-lite`.

This repository is intentionally an **API design example**, not the actual framework implementation.

## Mental model

```text
incoming HTTP request
  ↓
serverMiddleware
  ↓
serverRoute path matching
  ↓
HTTP method resolution
  ↓
route middleware
  ↓
handler(Request, context)
  ↓
Response
```

The developer only needs to remember:

```text
HTTP data        → Request
Framework state  → context
Output           → Response
```

## Complete request pipeline

```text
incoming Request
  ↓
serverMiddleware
  pre-route context only
  ↓
serverRoute path matching
  + static/dynamic precedence
  + param extraction
  ↓
HTTP method resolution
  + explicit method
  + HEAD fallback
  + automatic OPTIONS
  + 405
  ↓
group middleware
  ↓
path middleware
  ↓
method middleware
  ↓
handler(Request, context)
  ↓
Response
  ↑
middleware unwinds in reverse
```

## Server

```ts
export default defineServer({
  render: 'ssr',

  server: {
    port: 4211,
    trustProxy: true,
  },

  serverMiddleware: [
    loggerMiddleware,
  ],

  serverRoutes,
})
```

## `serverMiddleware`

`serverMiddleware` means **server-wide HTTP middleware**.

It runs before route matching and before route params exist.

It is intended only for cross-cutting HTTP behavior such as:

```text
logging
tracing
CORS
security headers
request timing
response headers
```

It remains separate from Vue navigation `defineMiddleware()`.

### Pre-route context

Because `serverMiddleware` runs before routing, it receives only pre-route framework context.

Available:

```text
context.requestId
other genuinely pre-routing request/server facts
```

Not available yet:

```text
context.params
route-specific application facts
route-specific middleware Provides
```

Route params become available only after a server route has been matched.

### Global serverMiddleware cannot provide route/business context

Middleware registered in:

```ts
serverMiddleware: [
  loggerMiddleware,
]
```

must not introduce typed business context that route modules depend on.

Appropriate:

```text
loggerMiddleware
corsMiddleware
tracingMiddleware
securityHeadersMiddleware
timingMiddleware
```

Not appropriate globally:

```text
authMiddleware       → user
tenantMiddleware     → tenant
workspaceMiddleware  → workspace
permissionsMiddleware → permissions
```

Business/request state belongs in:

```text
group middleware
path middleware
method middleware
```

This keeps independently defined route modules fully inferable.

No separate middleware helper is introduced.

## Server route ownership

Server-route ownership is deterministic:

```text
request
  ↓
matching serverRoute path?
  ├─ no  → continue normal SSR / Vue handling
  └─ yes → serverRoute owns the request
              ↓
           resolve HTTP method
```

A matched server-route path never falls through to Vue because the HTTP method is unsupported.

If a Vue page and server route both use the same path, the server route owns the request whenever its path and HTTP method match.

Example:

```text
Vue route:
  /products

Server route:
  GET /products

GET /products
→ serverRoute

POST /products
→ 405 Method Not Allowed
→ no Vue fallback
```

## HTTP method resolution

HTTP method resolution happens **before group/path/method middleware**.

Order:

```text
1. match serverRoute path
2. extract/decode params
3. resolve method behavior
4. only then enter route middleware
```

Method behavior:

```text
explicit method exists
→ use it

HEAD requested + no explicit HEAD + GET exists
→ GET semantics with body stripped

OPTIONS requested + no explicit OPTIONS
→ automatic OPTIONS response

matched path + unsupported method
→ 405 Method Not Allowed
```

This means:

```text
PUT /api/products
```

against a route that only declares GET/POST returns:

```text
405
```

before authentication or other route middleware runs.

Likewise automatic OPTIONS is framework HTTP behavior and does not enter route middleware first.

## Three route middleware scopes

### 1. Group middleware

Applies to every route and method inside the route group.

```ts
defineServerRoutes({
  prefix: '/api/products',

  middleware: [
    authMiddleware,
  ],

  routes: {
    // every route here is authenticated
  },
})
```

### 2. Path middleware

Applies to every supported HTTP method on one path.

```ts
'/:id': {
  middleware: [
    productMiddleware,
  ],

  GET() {},
  PATCH() {},
}
```

### 3. Method middleware

Applies to one HTTP method only.

```ts
'/:id': {
  GET() {
    // authenticated user
  },

  DELETE: {
    middleware: [
      adminMiddleware,
    ],

    handler() {
      // authenticated admin only
    },
  },
}
```

Route middleware execution:

```text
group middleware
  ↓
path middleware
  ↓
method middleware
  ↓
handler
```

Response unwinds in reverse.

## Middleware continuation

Middleware has exactly two outcomes.

Short-circuit:

```ts
return Response.json(
  { error: 'Unauthorized.' },
  { status: 401 },
)
```

Continue:

```ts
return next()
```

`next()` may be called at most once.

Middleware may do work after downstream execution:

```ts
const response = await next()

console.log(response.status)

return response
```

## Middleware type model

```ts
defineServerMiddleware<Provides, Requires>()
```

`Provides` describes context values guaranteed to downstream middleware and handlers.

`Requires` describes **all context that must already exist before this middleware runs**, including business values and routed framework context such as params.

### Auth middleware

```ts
defineServerMiddleware<{
  user: AuthenticatedUser
}>(...)
```

Provides `user`, requires nothing extra.

### Product middleware

```ts
defineServerMiddleware<
  {
    product: Product
  },
  {
    user: AuthenticatedUser
    params: {
      id: string
    }
  }
>(...)
```

Requires:

```text
user
params.id
```

Provides:

```text
product
```

Therefore it is valid on:

```text
/products/:id
```

and invalid on:

```text
/products
```

### Admin middleware

```ts
defineServerMiddleware<
  {
    isAdmin: true
  },
  {
    user: AuthenticatedUser
  }
>(...)
```

Requires `user` and provides `isAdmin`.

## Params available at each middleware scope

Params are available only after server-route path matching.

### Group middleware

Group middleware can require params from the group `prefix` only.

```ts
const organizationMiddleware =
  defineServerMiddleware<
    {
      organization: Organization
    },
    {
      params: {
        organizationId: string
      }
    }
  >(...)

defineServerRoutes({
  prefix: '/organizations/:organizationId',

  middleware: [
    organizationMiddleware,
  ],

  routes: {
    '/products/:productId': {
      GET() {},
    },
  },
})
```

At group scope:

```text
params.organizationId
→ available

params.productId
→ NOT available
```

### Path middleware

Path middleware can require params from:

```text
prefix + path
```

Example:

```ts
defineServerRoutes({
  prefix: '/organizations/:organizationId',

  routes: {
    '/products/:productId': {
      middleware: [
        productMiddleware,
      ],

      GET() {},
    },
  },
})
```

At path scope:

```text
params.organizationId
params.productId
```

are both available.

### Method middleware

Method middleware has the same final matched path params as path middleware:

```text
prefix + path
```

No new API is needed. This is only a type-composition rule.

## Context composition rule

Middleware `Provides` is additive.

**A middleware may not redeclare a context key that already exists.**

Example:

```text
authMiddleware provides:
  user: AuthenticatedUser

another middleware provides:
  user: SomeOtherUser

→ invalid
```

This also applies to framework-owned context keys.

Middleware must not provide replacements for:

```text
params
requestId
```

or other framework-owned context keys.

For v1 there is no implicit context refinement through duplicate keys.

## Context stages

### Pre-route context

Available to global `serverMiddleware`:

```text
context.requestId
pre-routing framework/request facts
```

No:

```text
context.params
```

### Routed context

Available after path matching to group/path/method middleware and handlers:

```text
context.requestId
context.params
route/application facts
accumulated middleware Provides
```

Rule:

```text
framework-owned request facts
→ context

business/request state
→ route middleware Provides

long-lived dependencies
→ normal imports
```

## Product route example

```ts
export const productsRoutes = defineServerRoutes({
  prefix: '/api/products',

  middleware: [
    authMiddleware,
  ],

  routes: {
    '/': {
      GET,
      POST,
    },

    '/:id': {
      middleware: [
        productMiddleware,
      ],

      GET,
      PATCH,

      DELETE: {
        middleware: [
          adminMiddleware,
        ],

        handler: deleteProduct,
      },
    },
  },
})
```

Result:

```text
GET    /api/products
POST   /api/products
GET    /api/products/:id
PATCH  /api/products/:id
DELETE /api/products/:id   admin only
```

## Params

Params are inferred from:

```text
prefix + child path
```

Example:

```ts
defineServerRoutes({
  prefix: '/organizations/:organizationId',

  routes: {
    '/products/:productId': {
      GET(_request, context) {
        context.params.organizationId
        context.params.productId
      },
    },
  },
})
```

Unknown param names should not exist in the handler type.

Initial route grammar stays intentionally small:

```text
/static/path
/:param
/users/:userId
/organizations/:organizationId/users/:userId
```

No optional params, wildcards, regex params, or catch-all syntax in the initial design.

Duplicate param names in the final combined path are invalid.

Example:

```text
prefix: /organizations/:id
route:  /products/:id

→ invalid
```

## Path normalization

```text
/api/products
/api/products/
```

are treated as the same route.

Paths otherwise remain case-sensitive:

```text
/Products
/products
```

are different routes.

Params are decoded once.

Malformed encoded params fail before route middleware or handler execution.

Static routes outrank dynamic routes.

Equivalent structural dynamic routes conflict:

```text
/users/:id
/users/:name
```

## Unhandled errors

No route-specific error API is introduced.

If a handler or middleware throws or returns a rejected promise and the error is not caught:

```text
unhandled throw / rejection
→ normal vue-ssr-lite framework error handling
→ HTTP 500
```

Middleware may catch downstream errors naturally:

```ts
try {
  return await next()
} catch (error) {
  // optional middleware-specific handling
}
```

No controller error layer, custom error envelope, or route error DSL is required.

## Request / Response

Use native Web APIs.

Query:

```ts
const url = new URL(request.url)
const page = url.searchParams.get('page')
```

Body:

```ts
const input: unknown = await request.json()
```

Response:

```ts
return Response.json(
  { ok: true },
  { status: 201 },
)
```

Do not duplicate native capabilities with:

```text
context.query
context.body
req.body
ctx.json()
send()
custom response envelopes
```

## Dependencies

Long-lived dependencies use normal imports:

```ts
import { db } from '../db'
```

Same rule for Redis, mail, storage, repositories, and services.

```text
Long-lived dependency
→ normal import

Request-specific value
→ context
```

## Route registration

Keep route groups as an array:

```ts
export const serverRoutes = [
  healthRoutes,
  productsRoutes,
  organizationRoutes,
]
```

Do not object-spread route maps together, because duplicate ownership can be overwritten before the framework sees it.

## Final public vocabulary

```text
defineServer()

serverRoutes
serverMiddleware

defineServerRoutes()

prefix
routes
middleware

defineServerMiddleware()

Request
Response

context
context.params
context.requestId
```

Middleware type vocabulary:

```text
Provides
Requires
```

No additional public primitive is introduced in v8.

This is the complete developer-facing blueprint to review before implementing the feature in the actual `vue-ssr-lite` library.
