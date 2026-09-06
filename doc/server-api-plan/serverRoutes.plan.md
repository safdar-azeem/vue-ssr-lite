# task-006 — First-Party Server Routes & Server Middleware

## Objective & Overview

Implement the already-approved first-party HTTP server-route architecture inside the real `vue-ssr-lite` library.

The public architecture has already been designed, reviewed through multiple iterations, and approved. This task is **implementation**, not API research or redesign.

The final developer-facing model must be:

```ts
defineServer({
  serverMiddleware: [loggerMiddleware],

  serverRoutes,
})
```

with route groups:

```ts
defineServerRoutes({
  prefix: '/api/products',

  middleware: [authMiddleware],

  routes: {
    '/': {
      GET() {},
      POST() {},
    },

    '/:id': {
      middleware: [productMiddleware],

      GET() {},
      PATCH() {},

      DELETE: {
        middleware: [adminMiddleware],

        handler() {},
      },
    },
  },
})
```

and server middleware:

```ts
defineServerMiddleware<
  Provides extends object = {},
  Requires extends object = {},
>(handler)
```

The generic defaults are:
- `Provides` defaults to `{}`
- `Requires` defaults to `{}`

This gives a seamless TypeScript developer experience across all three forms:
- **Zero generics** (`defineServerMiddleware(async (req, ctx, next) => ...)`): `Provides = {}`, `Requires = {}` (for ordinary cross-cutting middleware such as loggers, CORS, timing).
- **One generic** (`defineServerMiddleware<{ user: User }>(...)`): `Provides = { user: User }`, `Requires = {}` (for auth/session middleware that provides business context without preconditions).
- **Two generics** (`defineServerMiddleware<{ product: Product }, { user: User; params: { id: string } }>(...)`): `Provides = { product: Product }`, `Requires = { user: User; params: { id: string } }` (for downstream middleware requiring prior context).

The public request mental model is:

```text
Incoming Request
  ↓
[Transport / Framework Control Plane: Vite, health, readiness, private assets, direct static streaming]
  ↓ if application-owned
Host & Protocol Normalization → Application Selected
  ↓
serverMiddleware (global application HTTP middleware)
  ↓
serverRoute path matching (method-blind)
  ↓
HTTP method resolution
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
```

The implementation must preserve the simplicity of the approved blueprint:

```text
HTTP input        → native Request
framework state   → context
HTTP output       → native Response
dependencies      → normal imports
```

Do not introduce controllers, decorators, dependency injection, custom request/response wrappers, custom body parsers, file-based API routing, endpoint IDs, custom JSON helpers, or an alternate route DSL.

The repository already contains the approved design under:

```text
doc/server-api-plan/server-api-example/
```

Treat that blueprint as the public API source of truth.

The current single-app example still uses the old low-level `SsrEndpointDefinition` model with `id`, `ownedPaths`, `match`, manual method handling, manual JSON serialization, HEAD handling, and 405 handling. The purpose of this feature is to remove that ceremony for ordinary application HTTP routes.

---

# 1. Existing Architecture You Must Preserve

Before changing code, understand that `vue-ssr-lite` already has several independent layers.

## 1.1 Vue navigation middleware is NOT server middleware

The existing:

```ts
defineMiddleware()
```

belongs to Vue/Vue Router navigation.

It is universal when an application can SSR and is intentionally projected into browser-safe application code.

Do not reuse or modify the existing Vue middleware implementation to implement HTTP server middleware.

The new:

```ts
defineServerMiddleware()
```

is a completely separate server-only HTTP primitive.

The current public README describes `defineMiddleware()` as universal navigation middleware with route-entry behavior, redirects, props, cookies, and browser projection. Keep that behavior unchanged.

## 1.2 Existing internal endpoint machinery

Today an application can declare:

```ts
endpoints?: SsrEndpointDefinition[]
```

and the compiler copies those endpoints into each `SsrCompiledApplication`.
The request handler currently loops through those endpoints before static assets and before Vue SSR admission.

That internal ordering is useful and informs the new architecture:

```text
server routes
→ do NOT consume Vue SSR admission capacity
→ own HTTP paths before Vue rendering
→ outrank legacy endpoints at runtime
→ must coexist deterministically with legacy endpoints and SEO-owned HTTP resources
```

Do not implement server routes as Vue routes and do not send them through Vue SSR admission.

## 1.3 Built-in SEO currently uses endpoint ownership

Built-in `/robots.txt` and `/sitemap.xml` behavior is compiled through internal endpoints.

The compiler currently gives `createSeoEndpoints()` the consumer endpoint collection so exact `ownedPaths` can suppress built-in SEO resources.

SEO tests explicitly verify that consumer ownership of `/robots.txt` or `/sitemap.xml` prevents the built-in resource from being created without executing arbitrary endpoint match predicates during compilation.

The new server-route implementation must preserve this ownership behavior by exposing exact static server-route paths to the SEO compiler.

## 1.4 Request lifecycle separation

Current `SsrRequestHandler.ts` owns the end-to-end request lifecycle. The pipeline cleanly separates:

1. **Transport / Framework Control Plane**: Vite fallthrough, health check, readiness check, and private asset protections. These belong to framework operations and do NOT enter application-level middleware.
2. **Global Application HTTP Pipeline**: Forwarded host/protocol resolution, application selection, native `Request` instantiation, global `serverMiddleware`, `serverRoutes`, legacy endpoints, production static asset fallback preflight, non-HTML 404 fallback, and SPA/SSR rendering.

Do not replace this request handler with another server. Integrate the server-route pipeline into it.

## 1.5 Existing cancellation

The managed Node server already creates one canonical `SsrRequestScope`, cancels it when the incoming request is aborted or the outgoing response closes prematurely, and passes that signal through Core.

The native Web `Request.signal` created for server routes must use this same canonical signal.

Do not introduce another independent AbortController.

---

# 2. Public API Contract

Implement these new root runtime exports:

```ts
defineServerRoutes
defineServerMiddleware
```

They must be importable directly from:

```ts
import { defineServer, defineServerRoutes, defineServerMiddleware } from 'vue-ssr-lite'
```

The root package currently exports `defineServer`, `defineApplication`, `defineMiddleware`, `useFetch`, navigation APIs, SEO APIs, etc. Extend this surface deliberately rather than exposing internal route compiler/runtime helpers.

Supporting **type-only** exports may be added where required for declaration quality, for example:

```ts
ServerMiddleware
ServerMiddlewareHandler
ServerRouteContext
ServerRoutesDefinition
ServerRouteHandler
```

Do NOT publicly export runtime implementation helpers such as:

```text
compileServerRoutes
matchServerRoute
dispatchServerRoute
createWebRequest
executeServerMiddleware
SsrServerRouteRuntime
SsrWebHttpRuntime
```

Those are internal implementation details.

---

# 3. Configuration API

## 3.1 Single application

Support:

```ts
defineServer({
  render: 'ssr',

  serverMiddleware: [loggerMiddleware],

  serverRoutes: [healthRoutes, productsRoutes],
})
```

`serverRoutes` belongs to the single default application.

## 3.2 Multi-application configuration

The repository supports multiple applications on one Node process/port, selected by host/domain. Each application currently owns its Vue routes, SEO, middleware, shell, cache policy, etc.

For multi-app mode:

```ts
defineServer({
  serverMiddleware: [loggerMiddleware],

  applications: [website, admin],
})
```

and:

```ts
defineApplication({
  name: 'website',
  host: 'example.com',

  serverRoutes: [websiteRoutes],

  routes: vueRoutes,
})
```

### Required ownership rules

`serverMiddleware` is **global to the managed application HTTP pipeline**, so it belongs to `defineServer()`.

Do not add `serverMiddleware` to `defineApplication()`.

Per-application HTTP prerequisites belong in group/path/method middleware.

`serverRoutes` is application-owned:

```text
single app
→ defineServer({ serverRoutes })

multi app
→ defineApplication({ serverRoutes })
```

Top-level `serverRoutes` must be forbidden when `applications` is present, matching the existing single-vs-multi configuration discipline.

The same HTTP path may exist in different applications/hosts because host selection determines the application before route dispatch.

Route collision checks are therefore application-local, not global across all applications.

---

# 4. Configuration Type Changes

Update:

```text
src/SsrConfigTypes.ts
```

Add server-route types without coupling them to Vue Router types.

Recommended conceptual placement:

```ts
interface ApplicationConfigBase {
  ...
  serverRoutes?: readonly ServerRoutesDefinition[]
}
```

For single-app fields:

```ts
type SsrSingleApplicationFields = {
  ...
  serverRoutes?: readonly ServerRoutesDefinition[]
}
```

For multi-app server config:

```ts
serverRoutes?: never
```

because routes belong to each `defineApplication()`.

Add:

```ts
serverMiddleware?: readonly GlobalServerMiddleware[]
```

to the shared server configuration level so it works in both single- and multi-application configurations.

Update:

```text
SsrNormalizedApplicationConfig
SsrNormalizedConfig
SsrCompiledApplication
SsrCompiledConfig
```

accordingly.

### Internal Request Normalization Type

Update `SsrNormalizedRequest` in `src/server/SsrRequestHandler.ts`:

```ts
export interface SsrNormalizedRequest {
  readonly requestId: string
  readonly startedAt: number
  readonly method: string
  readonly url: string
  readonly headers: SsrHeaders
  readonly protocol: 'http' | 'https'
  readonly body?: ReadableStream<Uint8Array>
}
```

This carries the transport-bridged, one-shot body stream across the boundary from `SsrServerRuntime` into Core without exposing raw Node `IncomingMessage` to Core.

---

# 5. Strict Server-Only Compilation Boundary & Browser-Safe Root Exports

## 5.1 Server-only configuration fields

Both:

```text
serverRoutes
serverMiddleware
```

are **server-only configuration fields**.

They may legally import:

```text
database clients
Redis
filesystem
Node built-ins
private environment helpers
mailers
storage clients
authentication services
secrets
server repositories
```

They must never enter generated browser code.

The existing universal projection explicitly projects universal fields such as Vue middleware and extensions (`SSR_UNIVERSAL_RUNTIME_FIELDS` in `src/SsrUniversalProjection.ts`). Do **not** add `serverRoutes` or `serverMiddleware` to that projection list.

The client config projection must remain unaware of server-route modules.

Add/adjust compiler graph classification where necessary so code such as:

```ts
import { productsRoutes } from './server/routes/products'
```

where `products.ts` imports:

```ts
node:fs
database code
server credentials
```

does not become a universal/browser dependency and does not trigger false browser-safety failures.

This must work for both:

```text
server.ts
```

and server-route imports reachable from:

```text
defineApplication(...)
```

The generated client module must contain neither server route handlers nor server middleware imports.

## 5.2 Browser-safe root public exports

Because `vue-ssr-lite` (`src/index.ts`) is a universal entry point, the helper modules exported from `src/index.ts` must themselves be strictly browser-safe:

```text
src/server-routes/defineServerRoutes.ts
src/server-routes/defineServerMiddleware.ts
src/server-routes/SsrServerRouteTypes.ts
```

These modules must contain **only**:
- identity/helper functions
- browser-safe language primitives
- type-only imports and type declarations

They must **NOT** import:
- `node:*` built-ins
- `SsrServerRouteRuntime`
- `SsrServerMiddlewareRuntime`
- `SsrWebHttpRuntime`
- `SsrRequestHandler`
- filesystem or child process modules
- server compiler runtime modules

### Import Boundary Discipline:
- **Public helper barrel**: `src/server-routes/index.ts` re-exports only browser-safe definitions (`defineServerRoutes`, `defineServerMiddleware`, public types).
- **Internal server runtime**: Matchers, dispatchers, and Node transport bridges (`SsrServerRouteRuntime.ts`, `SsrServerMiddlewareRuntime.ts`, `SsrWebHttpRuntime.ts`) must remain internal and be imported only by the server runtime (`SsrRequestHandler.ts`, `SsrServerRuntime.ts`, `SsrConfigCompileRuntime.ts`). They must never be re-exported from `src/index.ts`.

---

# 6. Recommended Internal File Ownership

Structure:

```text
src/
├── server-routes/
│   ├── SsrServerRouteTypes.ts         # Public & internal route/middleware types (browser-safe)
│   ├── defineServerRoutes.ts          # Identity helper for route groups (browser-safe)
│   ├── defineServerMiddleware.ts      # Identity helper for middleware with generic defaults (browser-safe)
│   ├── SsrServerRouteRuntime.ts       # Route compilation, path-first matching, method resolution, Allow header (server-only)
│   ├── SsrServerMiddlewareRuntime.ts  # Middleware runner, next() continuation, double-next guards, unwinding (server-only)
│   └── index.ts                       # Public-safe export barrel
└── server/
    └── SsrWebHttpRuntime.ts           # Web Request/Response bridging, stream piping, body draining (server-only)
```

### Responsibilities:

#### `SsrServerRouteTypes.ts` (Browser-Safe)
Owns:
- Public handler signatures: `ServerRouteHandler<Context>`
- Public middleware signatures: `ServerMiddleware<Provides, Requires>`, `ServerMiddlewareHandler<Provides, Requires>`
- Phantom typing / metadata for Provides and Requires
- Route context composition types
- Path parameter inference types
- Route group definitions: `ServerRoutesDefinition`
- Compiled internal route types

#### `defineServerMiddleware.ts` (Browser-Safe)
Identity helper for HTTP middleware.
Declares generic defaults: `<Provides extends object = {}, Requires extends object = {}>`.
No business logic or server runtime dependencies.

#### `defineServerRoutes.ts` (Browser-Safe)
Typed identity helper for route groups.
Preserves literal prefix, route keys, middleware tuples, and method keys with `const` generics.
No business logic or server runtime dependencies.

#### `SsrServerRouteRuntime.ts` (Server-Only)
Owns:
- Path normalization
- Route compilation & structural validation
- Compile-time collision detection (static duplicates, dynamic structural duplicates, control-plane reserved path overlap, legacy endpoint `ownedPaths` overlap)
- Path-first method-blind matching
- Path param extraction and decoding
- HTTP method resolution
- Deterministic `Allow` header generation
- Server route execution dispatch

#### `SsrServerMiddlewareRuntime.ts` (Server-Only)
Owns:
- Composed middleware pipeline execution
- Mutable context threading
- `next()` continuation dispatch
- Double-`next()` invocation guard
- Short-circuit handling
- Reverse unwind execution

#### `SsrWebHttpRuntime.ts` (Server-Only)
Owns:
- `IncomingMessage` &rarr; Web `ReadableStream<Uint8Array>` body source
- `toWebHeaders()` conversion
- Native Web `Request` instantiation with trusted origin and canonical `scope.signal`
- Native Web `Response` &rarr; Node `ServerResponse` streaming pipeline with backpressure
- Draining/discarding unread incoming request bodies on early response
- Preservation of `status`, `statusText` (where present), and multiple `Set-Cookie` headers
- Adaptation of legacy `SsrHttpResponse` into native `Response` when legacy responses unwind through `serverMiddleware`

---

# 7. `defineServerMiddleware<Provides, Requires>()`

## 7.1 Generic signature and defaults

Freeze the exact generic contract:

```ts
export function defineServerMiddleware<
  Provides extends object = {},
  Requires extends object = {},
>(
  handler: ServerMiddlewareHandler<Provides, Requires>
): ServerMiddleware<Provides, Requires>
```

Both generics default to `{}`:
- `Provides` defaults to `{}`
- `Requires` defaults to `{}`

This guarantees clean support for all three usage forms:

1. **Zero generics**:
   ```ts
   const logger = defineServerMiddleware(async (request, context, next) => {
     const startedAt = performance.now()
     const response = await next()
     console.log(request.method, response.status, performance.now() - startedAt)
     return response
   })
   ```
   Inferred as `defineServerMiddleware<{}, {}>`.

2. **One generic (`Provides` only)**:
   ```ts
   const auth = defineServerMiddleware<{ user: User }>(async (request, context, next) => {
     const user = await authenticate(request)
     if (!user) return new Response(null, { status: 401 })
     context.user = user
     return next()
   })
   ```
   Inferred as `defineServerMiddleware<{ user: User }, {}>`.

3. **Two generics (`Provides` + `Requires`)**:
   ```ts
   const product = defineServerMiddleware<
     { product: Product },
     { user: User; params: { id: string } }
   >(async (request, context, next) => {
     const item = await db.find(context.params.id)
     if (!item) return new Response(null, { status: 404 })
     context.product = item
     return next()
   })
   ```
   Inferred as `defineServerMiddleware<{ product: Product }, { user: User; params: { id: string } }>`.

## 7.2 Provides semantics

Inside the middleware callback:
- `Requires` values are guaranteed and readable.
- `Provides` values are writable on `context`, but must NOT be considered guaranteed before assignment.

The middleware callback context type is:

```ts
BaseContext & Requires & Partial<Provides>
```

This prevents reading `context.user.id` before `context.user = user` is executed.

Downstream middleware and handlers see:

```ts
BaseContext & Requires & Provides
```

## 7.3 Requires semantics

`Requires` declares context properties that must already exist before this middleware executes. They can come from:
- route params (`params: { id: string }`)
- earlier group middleware
- earlier path middleware
- earlier method middleware

If a middleware's `Requires` is not satisfied by earlier context, TypeScript compilation fails.

## 7.4 Ordered middleware composition

Middleware tuples compose left-to-right:

```ts
middleware: [authMiddleware, adminMiddleware]
```

If `authMiddleware` provides `user` and `adminMiddleware` requires `user`, the sequence is valid.

Swapping them:

```ts
middleware: [adminMiddleware, authMiddleware]
```

must fail TypeScript compilation because `user` is missing when `adminMiddleware` runs.

## 7.5 Duplicate Provided keys & framework collisions

A middleware must not provide a key already supplied by:
- framework base context (`requestId`, `params`)
- earlier group, path, or method middleware

Do not silently overwrite or intersect duplicate types. Use invariant branding so assignability cannot hide conflicts.

---

# 8. Global `serverMiddleware` Type Restriction

Global `serverMiddleware` configured on `defineServer` is cross-cutting only.

Valid examples:
- logging
- tracing
- CORS
- security headers
- global timing
- response headers

It must not become an implicit source of typed route business state.

### Exact type constraint:

Global middleware must have:
- `Provides = {}`
- `Requires = {}`

```ts
type GlobalServerMiddleware = ServerMiddleware<{}, {}>
```

This guarantees:
1. It cannot provide business values (e.g. `user`) globally, which would bypass route-level authentication contracts.
2. It cannot require route-specific values (e.g. `params`), because it runs before route matching.

Global middleware receives `ServerMiddlewareBaseContext`:

```ts
export interface ServerMiddlewareBaseContext {
  readonly requestId: string
}
```

It does not receive `context.params`.

---

# 9. Route Context

Use one fresh mutable context object per request. No process-global or module-global request state.

### Context Lifecycle:

1. **Before route matching (Global Middleware stage)**:
   ```ts
   {
     requestId: string
   }
   ```
2. **After route matching & method resolution (Route Chain stage)**:
   ```ts
   {
     requestId: string,
     params: Readonly<Params>,
     ...middlewareProvidedValues
   }
   ```

Framework-owned properties (`requestId`, `params`) are read-only and cannot be overwritten.

Business properties added by middleware are attached directly to the context object (`context.user = user`).

Do not introduce a dependency injection container, service locator, or getter/setter registry.

---

# 10. Type-Safe Route Params

Params are inferred automatically from:

```text
prefix + child route path
```

Example:

```ts
defineServerRoutes({
  prefix: '/organizations/:orgId',

  routes: {
    '/products/:productId': {
      GET(_request, context) {
        context.params.orgId      // string
        context.params.productId  // string
      },
    },
  },
})
```

Both parameters infer as `string`. Accessing an unparsed param name like `context.params.id` is a TypeScript compilation error.

### Param availability by middleware scope:

- **Group middleware**: can only require params from `prefix`.
- **Path middleware**: can require params from `prefix + childPath`.
- **Method middleware**: can require params from `prefix + childPath`.

---

# 11. Route Path Grammar

The v1 route grammar is deliberately concise and deterministic.

### Syntax Rules:

1. **`prefix`**:
   - Optional string.
   - If present, must begin with `/` (e.g. `'/api'`).
   - `'/'` alone is valid (treated as root/empty prefix).
   - Trailing slashes are stripped/normalized during route compilation.

2. **Child route keys**:
   - Must begin with `/` (e.g. `'/'`, `'/:id'`).
   - Empty string `""` is strictly invalid &rarr; configuration error.
   - Query strings (`?`) or hash fragments (`#`) in route keys are strictly invalid &rarr; configuration error.

3. **Parameter segments**:
   - Pattern: `/:[A-Za-z_][A-Za-z0-9_]*`
   - Must use identifier grammar. Empty param names (e.g. `/:`) are invalid.
   - Duplicate param names in the same route path (e.g. `/:id/:id`) are invalid &rarr; configuration error.

4. **Concatenated path normalization**:
   - Adjacent slashes are collapsed (`//` &rarr; `/`).
   - Trailing slashes are normalized (e.g. `/api/products/` &rarr; `/api/products`), preserving root `'/'`.

5. **Explicitly unsupported in v1**:
   - Optional parameters: `:id?`
   - Wildcards: `*`, `**`
   - Regex constraints: `:id(\d+)`
   - Catch-all / splat parameters: `[...slug]`, `[[...slug]]`
   - Ambiguous dot segments: `/api/../other`

---

# 12. Path Normalization

Normalized paths follow these semantics:

- `/api/products` and `/api/products/` represent the exact same route.
- Paths remain strictly case-sensitive: `/api/Products` and `/api/products` are different paths.
- URL parameters are percent-decoded exactly once.
- Malformed percent encoding in request URLs (e.g. `/users/%E0%A4%A`) must produce an immediate **HTTP 400 Bad Request** before route middleware or handlers run. Partially decoded or corrupted values are never exposed to handlers.

---

# 13. Route Compilation

Server routes are compiled when the server configuration is initialized or reloaded.

- Compiled route tables are immutable and shared across requests for that application.
- Route structures are flattened into precomputed records:
  - normalized pattern
  - static segments vs dynamic parameter positions
  - parameter name list
  - compiled regex matcher for dynamic routes
  - exact static owned path (if static)
  - HTTP method map & precomputed canonical `Allow` header
  - ordered group, path, and method middleware chains
  - handler function references
- Development config reload creates a new immutable route table alongside the new config revision. In-flight requests continue executing against their initial route table snapshot.

---

# 14. Route Collision & Precedence Rules

Collision detection is deterministic and independent of registration/import order.

## 14.1 Static route collisions

If two route declarations define the same normalized static `METHOD + path` for the same application, compilation throws a configuration error:

```text
Duplicate server route: GET /api/products
```

Disjoint methods on the same static path are compiled into the same path entry.

## 14.2 Dynamic structural collisions

Structurally identical dynamic patterns within the same application conflict:

```text
/users/:id
/users/:name
```

Both match any single segment after `/users/`. Registering both within one application is a compile-time configuration error.

## 14.3 Static outranks dynamic (Path-First, Method-Blind)

Route selection is strictly **method-blind**:

1. Request pathname is tested against static routes first.
2. If no static route matches, dynamic routes are tested in order of segment specificity.
3. **The matched route claims exclusive path ownership immediately.**
4. Method resolution occurs **after** path ownership is established.

### Method-Blind Ownership Example:

Suppose an application declares:

```text
/users/me   → GET
/users/:id  → POST
```

Request:

```text
POST /users/me
```

**Required behavior**:
- Static path `/users/me` claims path ownership.
- `/users/me` does not support `POST`.
- Return **HTTP 405 Method Not Allowed** with `Allow: GET, HEAD, OPTIONS`.
- **DO NOT** fall through to `/users/:id` simply because `/users/:id` declares `POST`.

## 14.4 Control-plane collision checking (including dynamic routes)

Server routes must never shadow framework control-plane endpoints:
- `healthPath` (default `/health`)
- `readinessPath` (default `/readiness`)

During compilation:
- Test all compiled server-route patterns (both static and dynamic patterns, such as `/:id` or `/api/:status`) against `healthPath` and `readinessPath`.
- If any server route pattern matches a configured control path, throw a fatal compile-time configuration error:
  ```text
  Server route pattern "${pattern}" matches reserved framework control path "${healthPath}". Reserved control paths cannot be intercepted or shadowed by server routes.
  ```

## 14.5 Legacy endpoint collision checking

Compile-time coexistence with legacy `endpoints`:
1. Collect exact static paths owned by all compiled `serverRoutes` for the application.
2. Inspect legacy `endpoints` configured on that application:
   - For endpoints with explicit `ownedPaths`: if any static `serverRoute` path overlaps with a legacy `ownedPath`, throw a compile-time configuration error:
     ```text
     Duplicate owned path "${path}" declared by both serverRoutes and legacy endpoint "${endpoint.id}".
     ```
   - For endpoints with opaque `match()` predicates: these cannot be analyzed at compile time. Never run `match()` predicates during compilation. At runtime, `serverRoutes` path matching takes priority; legacy `match()` predicates are evaluated only when no server route matches.

## 14.6 Multi-application isolation

Route collisions are strictly application-local. Declaring `GET /api/products` in Application A and `GET /api/products` in Application B is valid because host routing partitions their route tables.

---

# 15. HTTP Method Model & Handler Return Contracts

Supported methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`. Method keys are uppercase.

## 15.1 Direct handler vs configured method

```ts
routes: {
  '/api/items': {
    // Direct handler
    GET(request, context) {
      return Response.json({ items: [] })
    },

    // Configured method with method-level middleware
    DELETE: {
      middleware: [adminMiddleware],
      handler(request, context) {
        return new Response(null, { status: 204 })
      },
    },
  },
}
```

## 15.2 Strict return contract & runtime validation

### Signatures:

```ts
type ServerRouteHandler<Context> = (
  request: Request,
  context: Context
) => Response | Promise<Response>

type ServerMiddlewareHandler<Provides, Requires> = (
  request: Request,
  context: MiddlewareContext<Provides, Requires>,
  next: () => Promise<Response>
) => Response | Promise<Response>
```

### Runtime contract:

- Every handler and middleware must return a real native `Response` instance (or a Promise resolving to one).
- The runtime verifies `result instanceof Response`.
- If a handler or middleware returns non-`Response` (such as `undefined` due to a missing `return next()`, `null`, plain object, or string):
  - The runtime throws a deterministic error:
    ```text
    Server route handler or middleware must return a native Response instance; received <type>.
    ```
  - This error enters the normal uncaught server-route failure path &rarr; **HTTP 500**.
  - **No coercion**: do not coerce objects to JSON, strings to text, or null/undefined to empty responses.

---

# 16. HTTP Method Resolution Before Route Middleware

Once a path is matched, method resolution occurs before running route middleware (group, path, or method middleware).

### Resolution Rules:

1. **Path matched + method supported**:
   Execute the route middleware chain: group &rarr; path &rarr; method &rarr; handler.
2. **Path matched + explicit OPTIONS declared**:
   Execute the explicit OPTIONS route chain: group &rarr; path &rarr; method &rarr; explicit OPTIONS handler.
3. **Path matched + OPTIONS requested + no explicit OPTIONS**:
   Synthesize automatic OPTIONS response immediately.
   - Return **HTTP 204** with empty body (`null`) and calculated `Allow` header.
   - **Bypasses group/path/method middleware**.
4. **Path matched + HEAD requested + no explicit HEAD + GET exists**:
   Execute GET route chain (group &rarr; path &rarr; GET handler).
   - Transport suppresses body bytes while preserving status and headers.
5. **Path matched + unsupported method**:
   Return **HTTP 405 Method Not Allowed** immediately.
   - Return **HTTP 405** with empty body (`null`) and calculated `Allow` header.
   - **Bypasses group/path/method middleware**.
6. **No path match**:
   Fall through to the remainder of the application pipeline (legacy endpoints, production static assets, non-HTML 404, Vue SSR/SPA).

Global `serverMiddleware` has already executed before route path matching because it wraps the application HTTP pipeline.

---

# 17. `Allow` Header & Automatic Framework Responses

## 17.1 Exact canonical `Allow` header ordering

The `Allow` header must follow a deterministic canonical method ordering:

```ts
const CANONICAL_ALLOW_ORDER = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const
```

### Construction Algorithm:

For the matched route path, filter `CANONICAL_ALLOW_ORDER` to include only:
- Any method explicitly declared on that route.
- `HEAD` if explicitly declared OR if `GET` is declared.
- `OPTIONS` (always available via explicit handler or automatic synthesis).

Join the filtered list with `', '` (comma + space).

### Examples:
- Route declares `GET` and `POST`:
  `Allow: GET, HEAD, POST, OPTIONS`
- Route declares `POST` and `DELETE`:
  `Allow: POST, DELETE, OPTIONS`
- Route declares `GET`:
  `Allow: GET, HEAD, OPTIONS`

Declaration order or property key order in configuration has zero effect on the `Allow` header.

## 17.2 Framework automatic response specifications

Both framework-synthesized responses use empty (`null`) bodies to keep the framework free of application error-envelope conventions:

### Automatic OPTIONS (204 No Content):
```ts
new Response(null, {
  status: 204,
  headers: {
    Allow: allowHeaderValue,
  },
})
```

### Automatic 405 Method Not Allowed:
```ts
new Response(null, {
  status: 405,
  headers: {
    Allow: allowHeaderValue,
  },
})
```

---

# 18. HEAD Semantics

HEAD semantics follow normal path precedence:

1. **Path-first resolution**: Path matching selects the route using standard method-blind matching.
2. **Explicit HEAD**: If the matched route declares `HEAD()`, execute its explicit chain.
3. **GET-backed HEAD**: If the matched route does not declare `HEAD` but declares `GET`:
   - Resolve to that route's GET definition.
   - Execute that route's GET middleware chain and handler.
   - Incoming native `Request` retains `request.method === 'HEAD'` (do not mutate request method).
   - Transport omits the response body bytes while preserving status and headers.
   - Safely cancel or discard the response stream if a streaming body was produced.
4. **No GET**: If the route has neither HEAD nor GET, return **HTTP 405**. Do not search other routes.

---

# 19. Native Web `Request` & Transport Handoff Boundary

Handlers and HTTP middleware receive a standard native Web `Request`.

## 19.1 Transport &rarr; Core handoff boundary

Transport and Core responsibilities are strictly separated:

```text
Node Transport (SsrServerRuntime)
  receives IncomingMessage
  ↓
  creates one-shot ReadableStream<Uint8Array> (body-capable methods only)
  ↓
  attaches to SsrNormalizedRequest.body
  ↓
Core Request Handler (SsrRequestHandler)
  resolves trusted host and protocol
  ↓
  constructs ONE canonical native Request:
    - absolute trusted URL
    - original HTTP method
    - copied Headers
    - body stream source
    - duplex: 'half' (when body present)
    - signal: scope.signal
```

### Strict Transport Rules:
- For `GET` and `HEAD` requests: `normalizedRequest.body` is strictly `undefined`.
- For body-capable methods (`POST`, `PUT`, `PATCH`, `DELETE`, etc.): bridge `IncomingMessage` into a Web `ReadableStream<Uint8Array>` (using Node's `Readable.toWeb(request)`).
- Do NOT construct the final native `Request` in Node transport using untrusted host/protocol headers.
- Do NOT buffer the incoming request body in memory.
- Do NOT create multiple native `Request` instances from the same one-shot body stream.
- `request.signal` is bound strictly to canonical `SsrRequestScope.signal`.

## 19.2 Unread incoming request body lifecycle

When a response is sent before the incoming request body has been fully consumed (e.g. global middleware short-circuits with 401, route returns 405 before handler, or early return from handler):

1. **Connection remains healthy**: If the request is not aborted and socket is alive, the transport resumes and drains/discards remaining chunks of `IncomingMessage` (e.g. `incomingMessage.resume()`) to allow clean socket keep-alive reuse without hanging.
2. **Request aborted / stream error**: If the request was aborted or stream failed, destroy/cancel the stream per existing request scope semantics.
3. **Application isolation**: Application handlers and middleware are never responsible for cleaning up unread Node request bodies.

---

# 20. Request Bodies Stay Application-Owned

The framework does not provide a validation or schema DSL. Applications parse bodies directly using Web standard APIs:

```ts
const body = await request.json()
```

or `request.text()`, `request.formData()`, `request.arrayBuffer()`, etc.

Applications may use Zod, Valibot, ArkType, TypeBox, or custom validation functions. No schema libraries are bundled or required.

---

# 21. Native Web `Response`

Handlers and middleware return standard native `Response` objects:

```ts
Response.json({ status: 'ok' })
Response.redirect('/login', 302)
new Response('plain text', { status: 200, headers: { 'content-type': 'text/plain' } })
new Response(null, { status: 204 })
```

Do not add custom response wrappers (`ctx.json()`, `res.send()`).

---

# 22. Native Response &rarr; Node Transport

Implement a streaming Response writer in `src/server/SsrWebHttpRuntime.ts`:

- **Status & StatusText**: Write `response.status` to `res.statusCode`. If `response.statusText` is non-empty, write it to `res.statusMessage`. Do not construct custom status text maps.
- **Headers**: Copy headers to Node `ServerResponse`.
- **Cookies**: Use `response.headers.getSetCookie()` where supported to emit multiple discrete `Set-Cookie` headers instead of collapsing them into a comma-joined string.
- **Streaming Body**: Stream `response.body` to Node `res` using `Readable.fromWeb()` and `pipeline()` to maintain backpressure.
- **Empty Body**: If `response.body` is null (204, 304, automatic OPTIONS, 405), end the response immediately without writing bytes.
- **HEAD Requests**: Emit headers and status, omit body bytes, and safely cancel the Web stream.
- **Cancellation**: If `scope.signal` aborts while streaming, terminate the response stream immediately.

---

# 23. Legacy `SsrHttpResponse` Interoperability

Do not rewrite internal SSR, SEO, or cache subsystems to native `Response` in this task.

Maintain an internal adapter in `src/server/SsrWebHttpRuntime.ts`:

```ts
export function ssrHttpResponseToWebResponse(legacy: SsrHttpResponse): Response
```

When a legacy endpoint or SSR fallback executes inside the `serverMiddleware` continuation, this adapter converts the legacy response into a native `Response` so middleware reverse-unwinding can inspect it uniformly.

---

# 24. Server Middleware Runtime

## 24.1 Execution order

1. **Global application middleware**: `defineServer({ serverMiddleware: [...] })` runs first.
2. Inside `next()` continuation: route matching and method resolution occur.
3. If matched:
   - **Group middleware**: declared on `defineServerRoutes({ middleware: [...] })`
   - **Path middleware**: declared on `routes['/path']: { middleware: [...] }`
   - **Method middleware**: declared on `DELETE: { middleware: [...], handler }`
   - **Handler**: `handler(request, context)`

## 24.2 Reverse unwinding

Middleware unwinds in strict reverse order:

```text
Global middleware before next()
  → Group middleware before next()
    → Path middleware before next()
      → Method middleware before next()
        → Handler
      → Method middleware after next()
    → Path middleware after next()
  → Group middleware after next()
→ Global middleware after next()
```

Middleware can observe status, modify headers, or wrap the returned `Response`.

## 24.3 Double next() protection

Each middleware may invoke its `next()` callback at most once. Calling `next()` a second time throws a fatal framework error.

## 24.4 Short-circuiting

If middleware returns a `Response` without calling `next()`, downstream middleware and handlers do not execute. Outer middleware still unwinds normally.

---

# 25. Authoritative Request Pipeline & Ownership Hierarchy

This section is the **single authoritative source of truth** for request processing in `vue-ssr-lite`. All components must adhere strictly to this sequence.

```text
=============================================================================
1. TRANSPORT & FRAMEWORK CONTROL PLANE (Bypasses user serverMiddleware)
=============================================================================
Incoming Node HTTP Request (IncomingMessage, ServerResponse)
  ↓
1.1 Vite Development Middleware / HMR (development mode only)
    If Vite handles the request (modules, HMR, Vite client assets) → End
  ↓
1.2 Private Framework Resources
    If isPrivateProductionAssetPath(pathname) → Return 404 JSON
  ↓
1.3 Health Endpoint
    If pathname === serverOptions.healthPath → Return 200 JSON
  ↓
1.4 Readiness Endpoint
    If pathname === serverOptions.readinessPath → Check readiness → Return 200 / 503 JSON

=============================================================================
2. REQUEST NORMALIZATION & HOST ROUTING
=============================================================================
  ↓
2.1 Forwarded Host Resolution
    Resolve host via x-forwarded-host / host (respecting trustProxy).
    If invalid → Return 400.
  ↓
2.2 Application Selection
    Match host to configured application via metadata.resolveHost(incomingHost).
    If no match → Return 421 Misdirected Request.
  ↓
2.3 Forwarded Protocol Resolution
    Resolve protocol via x-forwarded-proto / socket.encrypted (respecting trustProxy).
  ↓
2.4 Trusted Request Instantiation
    - Construct trusted absolute URL: ${protocol}://${incomingHost}${pathname}${search}
    - Transport bridges IncomingMessage to one-shot ReadableStream<Uint8Array> (non-GET/HEAD)
    - Construct ONE canonical native Request(trustedUrl, { method, headers, body, signal })
    - Create fresh base request context: { requestId }

=============================================================================
3. GLOBAL APPLICATION HTTP PIPELINE (Wrapped by user serverMiddleware)
=============================================================================
  ↓
3.1 Execute serverMiddleware
    Run global serverMiddleware pipeline.
    All downstream application steps run inside the serverMiddleware continuation:

      =======================================================================
      3.2 serverRoutes Path Ownership (Method-Blind)
      =======================================================================
      Match request pathname against application's compiled serverRoutes.
      (Static routes first, dynamic routes second; method-blind).

      IF A ROUTE PATH MATCHES:
        Route claims exclusive path ownership.
        Resolve HTTP Method:
        ├─ Method supported:
        │    Execute route chain: group → path → method middleware → handler
        │    Return handler Response
        ├─ Explicit OPTIONS:
        │    Execute explicit OPTIONS chain: group → path → method → handler
        │    Return handler Response
        ├─ Synthesized OPTIONS (no explicit OPTIONS):
        │    Return 204 No Content (null body, Allow header)
        ├─ GET-backed HEAD (HEAD requested, no explicit HEAD, GET exists):
        │    Execute GET route chain; transport strips body
        │    Return Response (status + headers)
        └─ Unsupported Method:
             Return 405 Method Not Allowed (null body, Allow header)

        (Note: If a serverRoute path matches, legacy endpoints and production
         static asset checks are NEVER reached!)

      =======================================================================
      3.3 Unmatched Route Fallbacks (If NO serverRoute path matched)
      =======================================================================
      IF NO ROUTE PATH MATCHED:
        ├─ 3.3.1 Legacy Endpoints Compatibility
        │        Evaluate legacy application endpoints via endpoint.match(renderRequest).
        │        If matched → execute endpoint.handle() → Return response.
        │
        ├─ 3.3.2 Production Static Asset Streaming
        │        If production && (GET || HEAD) && asset exists on disk:
        │          Stream static asset directly via ServerResponse.
        │
        ├─ 3.3.3 Application Non-HTML Fallback
        │        If request is not an HTML navigation:
        │          Return 404 Not Found (JSON / text).
        │
        └─ 3.3.4 Vue Application Response (SPA / SSR)
                 HTML navigation proceeds to Vue application rendering:
                 - Acquire SSR admission lease (SSR only)
                 - Render Vue component tree (or emit SPA shell template)
                 - Return HTML document response
```

### Ownership Precedence Rules:
- **Server Routes vs Production Static Assets**: When a `serverRoute` path matches the request pathname, the server route takes precedence. Physical static asset serving is reached only when no server route matches.
- **Server Routes vs Legacy Endpoints**: Server routes take precedence over legacy endpoints.
- **Method-blind matching**: An unsupported HTTP method on a matched server route path returns 405; it never falls through to legacy endpoints, static assets, or Vue rendering.

---

# 26. Server Route Dispatch Order Relative to Existing Endpoints

Reference the authoritative pipeline in Section 25.

- `serverRoutes` is evaluated before legacy endpoints.
- Static path overlap between `serverRoutes` and legacy endpoint `ownedPaths` is rejected at compile time (Section 14.5).
- If a server route path matches, it claims the request exclusively. If the method is unsupported, it returns **HTTP 405** and never falls back to legacy endpoints.

---

# 27. Legacy `endpoints` Compatibility

Do not remove legacy endpoints in this task:
- Preserved for internal SEO and backwards compatibility.
- First-party examples and documentation migrate to `serverRoutes`.
- Legacy endpoints with `ownedPaths` participate in compile-time collision checks.
- Legacy endpoints with opaque `match()` predicates remain supported at runtime if no server route matches.

---

# 28. SEO Ownership Integration

A server route declaring `/robots.txt` or `/sitemap.xml` owns that path:
- The route compiler provides exact static owned paths to the SEO compiler.
- Combined static ownership set:
  ```text
  compiled serverRoute exact static paths + legacy endpoint ownedPaths
  ```
- If `/robots.txt` or `/sitemap.xml` is in the static ownership set, the built-in SEO endpoint is suppressed.
- If a server route owns `/robots.txt` with only `POST`, a `GET /robots.txt` request matches the server route and returns **HTTP 405**; it does not fall back to built-in robots.txt.

---

# 29. Multi-Application Behavior

- Host routing occurs before application HTTP dispatch.
- Each application has its own compiled server-route table.
- Route collision detection is application-local.
- Every request receives a fresh, isolated context object. No context state leaks across applications or concurrent requests.

---

# 30. Interaction with SSR Admission

Server routes do not consume Vue SSR admission capacity (`maxConcurrentSsrRequests`, `maxQueuedSsrRequests`). Only requests that fall through to Vue SSR rendering acquire an admission lease.

---

# 31. Error Behavior

- Returning an error response (`Response.json({ error }, { status: 400 })`) is normal application flow.
- If a handler or middleware throws/rejects, or returns a non-`Response` object:
  - The failure enters the centralized server error handler &rarr; **HTTP 500**.
  - Internal errors are logged safely via `safeSsrLog`.
- Middleware may wrap `await next()` in `try / catch` to handle downstream errors and return fallback responses.

---

# 32. Cancellation & Timeout

- Native `request.signal` is bound to canonical `SsrRequestScope.signal`.
- If client disconnects, request times out (`server.requestTimeoutMs`), or server cancels, `request.signal` aborts.
- Handlers should pass `request.signal` to downstream fetch/database calls.
- Streaming response writer stops immediately when the signal aborts.

---

# 33. Query Parameters

No `context.query` or `request.query`. Handlers read query parameters standardly via:

```ts
const url = new URL(request.url)
const queryParam = url.searchParams.get('q')
```

`request.url` is guaranteed to be an absolute URL with trusted host and protocol.

---

# 34. Dependency Model

Long-lived dependencies (database, Redis, mailer, storage clients) are imported using standard ES imports:

```ts
import { db } from '../db'
```

No dependency injection container, decorator framework, or server context registry.

---

# 35. Public Export Changes

Update `src/index.ts` to export:

```ts
export { defineServerRoutes } from './server-routes/defineServerRoutes'
export { defineServerMiddleware } from './server-routes/defineServerMiddleware'
export type {
  ServerMiddleware,
  ServerMiddlewareHandler,
  ServerMiddlewareBaseContext,
  ServerRouteContext,
  ServerRoutesDefinition,
  ServerRouteHandler,
} from './server-routes/SsrServerRouteTypes'
```

Update:
- `src/SsrPublicApi.test.ts`
- `scripts/SsrPackageArtifact.mjs`
- `scripts/SsrPackageSmoke.mjs`

to include `defineServerRoutes` and `defineServerMiddleware` in the expected root package exports.

---

# 36. Existing Single-App Example Migration

Migrate `examples/1-single-app/server/products.ts` from `SsrEndpointDefinition` to `defineServerRoutes`:

```ts
export const productsRoutes = defineServerRoutes({
  prefix: '/api/products',

  routes: {
    '/': {
      GET(request) {
        const failure = new URL(request.url).searchParams.get('fail') === 'true'
        return Response.json(
          failure ? { error: 'Simulated failure.' } : { products },
          {
            status: failure ? 503 : 200,
            headers: { 'cache-control': 'no-store' },
          }
        )
      },
    },
  },
})
```

Register in `examples/1-single-app/server.ts`:

```ts
defineServer({
  ...
  serverRoutes: [productsRoutes],
})
```

Update `examples/1-single-app/README.md` to reference server routes.

---

# 37. Approved Blueprint Documentation

Keep `doc/server-api-plan/server-api-example/` as the architectural example.

This document (`doc/server-api-plan/serverRoutes.plan.md`) is the canonical implementation plan. Do not create another copy.

Update root `README.md` with a concise Server Routes section explaining:
- `defineServerRoutes`
- `defineServerMiddleware`
- `serverRoutes` & `serverMiddleware`
- Native Request/Response
- Three route middleware scopes (group, path, method)
- Distinction between `defineMiddleware()` (Vue navigation) and `defineServerMiddleware()` (Server HTTP)

---

# 38. useFetch Integration

Update `src/data/fetch/__tests__/SsrFetchProductsEndpoint.test.ts` (or `SsrFetchProductsServerRoute.test.ts`) to test `useFetch` requesting `/api/products` against the new first-party server route over HTTP.

---

# 39. Required Runtime Tests to WRITE

Write tests covering all specified contracts. (Do NOT run them during implementation; the repository owner will run them).

### Route Compilation & Collisions:
- Static routes, dynamic routes, prefix joining, slash normalization, case sensitivity.
- Duplicate static `METHOD + path` throws configuration error.
- Structurally identical dynamic routes (`/users/:id` vs `/users/:name`) throw configuration error.
- **Dynamic control-plane collision**: Dynamic pattern matching `/health` or `/readiness` (e.g. `/:id` or `/api/:status`) throws compile-time configuration error ([M-6]).
- **Legacy endpoint static collision**: Static server route matching legacy endpoint `ownedPaths` throws compile-time configuration error ([M-4]).
- Multi-app route table isolation.

### Path-First, Method-Blind Matching ([M-5]):
- Route `/users/me` with `GET` only, and route `/users/:id` with `POST` only.
- Request `POST /users/me` matches `/users/me` and returns **HTTP 405** with `Allow: GET, HEAD, OPTIONS`.
- Verify it does **NOT** fall through to `/users/:id`.

### Canonical `Allow` Header & Framework Responses ([M-7], [M-10], [N-2]):
- Canonical ordering: `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`.
- Automatic synthesized OPTIONS returns 204 with `null` body and `Allow` header; bypasses route middleware.
- Explicit OPTIONS executes route middleware chain ([N-2]).
- Unsupported method returns 405 with `null` body and `Allow` header; bypasses route middleware.
- Explicit HEAD vs GET-backed HEAD (with body suppression).

### Middleware Runtime & Generic Defaults ([B-1], [N-4], [M-2]):
- Zero generics: `defineServerMiddleware(async (req, ctx, next) => ...)` compiles cleanly.
- One generic: `defineServerMiddleware<{ user: User }>(...)` provides context without requires.
- Two generics: `defineServerMiddleware<Provides, Requires>(...)` requires prior context.
- Execution order: global &rarr; group &rarr; path &rarr; method &rarr; handler.
- Reverse unwind order: handler &rarr; method &rarr; path &rarr; group &rarr; global.
- Double-`next()` guard throws deterministic error.
- Short-circuiting returns response without executing downstream chain.
- Handler/middleware returning non-Response throws error and yields HTTP 500 ([M-2]).

### serverMiddleware Inclusion/Exclusion Boundaries ([B-3], [N-6]):
- **DOES run for**:
  - Matched server routes
  - 405 Method Not Allowed responses
  - Synthesized 204 OPTIONS responses
  - Legacy endpoints
  - Vue SSR renders
  - Vue SPA renders
  - Non-HTML 404 fallbacks
- **Does NOT run for**:
  - Health check requests (`healthPath`)
  - Readiness check requests (`readinessPath`)
  - Private production asset paths (`isPrivateProductionAssetPath`)
  - Vite development requests / HMR (`serveViteRequest`)
  - Direct static production asset streaming

### Request Body & Unread Body Lifecycle ([B-2], [M-3]):
- GET/HEAD requests have `body === undefined`.
- POST/PUT streaming body received as one-shot `ReadableStream<Uint8Array>`.
- `request.json()` and `request.text()` read payload correctly.
- Native `request.signal` aborts on client disconnect.
- Unread request body on 401 short-circuit, 405, or early handler return is drained/resumed to maintain keep-alive socket health ([M-3]).

### Response Streaming & Status ([N-5]):
- Native Response body streaming with backpressure.
- Preservation of non-empty `response.statusText` on `res.statusMessage`.
- Multiple `Set-Cookie` headers preserved via `getSetCookie()`.

### Browser Isolation & Packaging ([M-1]):
- `src/index.ts` exports `defineServerRoutes` and `defineServerMiddleware` as browser-safe modules.
- No `node:*` or server runtime modules in universal bundle.
- Server-only modules (`database`, `node:fs`) imported by server routes do not enter browser bundle projection.

---

# 40. Acceptance Criteria

1. **Public API**: `defineServer`, `defineServerRoutes`, `defineServerMiddleware` importable from `vue-ssr-lite`.
2. **Generic Contracts**: `defineServerMiddleware` supports zero, one, or two generics with defaults to `{}`.
3. **Transport Body Boundary**: Transport attaches one-shot `ReadableStream<Uint8Array>` to `SsrNormalizedRequest.body` (excluding GET/HEAD); Core constructs single native `Request` with trusted URL and canonical `scope.signal`.
4. **Authoritative Pipeline**: Framework control-plane paths bypass `serverMiddleware`; application pipeline is wrapped by `serverMiddleware`; server routes outrank physical static assets and legacy endpoints.
5. **Path-First Routing**: Route selection is method-blind; unmatched methods return 405 without falling through to dynamic routes.
6. **Collision Detection**: Compile-time detection covers static duplicates, dynamic structural duplicates, control-plane path collisions (including dynamic patterns), and static collisions with legacy `ownedPaths`.
7. **Allow Header**: Canonical order `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`.
8. **Automatic Responses**: Automatic OPTIONS is 204 with `null` body; 405 is 405 with `null` body.
9. **Return Contracts**: Handlers and middleware must return `Response`; invalid returns yield HTTP 500 without coercion.
10. **Body Draining**: Unread request bodies on early return / short-circuit are drained cleanly.
11. **Browser Safety**: Universal root exports are strictly browser-safe and free of server runtime dependencies.
12. **Example & useFetch**: `examples/1-single-app` uses `serverRoutes`; `useFetch` same-origin test passes.
13. **Vue Integrity**: Vue navigation middleware, SSR/SPA rendering, SEO, and hydration remain fully functional.

---

# 41. Important Edge Cases

- `prefix: '/'` + child `'/'` &rarr; normalized to `'/'`.
- Empty prefix + child `'/api'` &rarr; `'/api'`.
- Duplicate trailing slashes collapsed.
- Static path `/new` alongside dynamic `/:id` &rarr; static `/new` always wins.
- Malformed percent encoding &rarr; immediate HTTP 400.
- POST request to GET-only static route with dynamic sibling &rarr; HTTP 405 from static route, no fall-through.
- Dynamic route pattern `/:id` matching `/health` &rarr; compile-time configuration error.
- Static server route path matching legacy `ownedPaths` &rarr; compile-time configuration error.
- Middleware short-circuiting with 401 on POST request &rarr; unread body drained, keep-alive socket reused.
- Handler returning `undefined` (missing `return next()`) &rarr; uncaught error &rarr; HTTP 500.
- Middleware calling `next()` twice &rarr; deterministic rejection.
- Explicit OPTIONS on authenticated route &rarr; executes auth middleware.
- Automatic OPTIONS on authenticated route &rarr; bypasses route auth middleware, returns 204.
- Multiple `Set-Cookie` headers on native Response &rarr; emitted as multiple discrete headers.

---

# 42. Non-Goals

Do NOT add in this task:
- File-based API routing
- Controllers or decorators
- Dependency injection container
- `request.query` or `context.query`
- Automatic body validation / Zod integration
- OpenAPI generation
- WebSocket / SSE routing
- Wildcards, regex parameters, or catch-all parameters
- Route reverse generation DSL
- Custom response helper abstractions

---

# 43. Implementation Order

1. **Browser-safe public types & helpers**: `SsrServerRouteTypes.ts`, `defineServerRoutes.ts`, `defineServerMiddleware.ts`.
2. **Config types & compilation**: Update `SsrConfigTypes.ts`, `SsrConfigCompileRuntime.ts` with compile-time collision checks.
3. **Server-only boundary**: Ensure compiler graph treats `serverRoutes` and `serverMiddleware` as strictly server-only.
4. **Route compiler & matcher**: `SsrServerRouteRuntime.ts` with path-first method-blind matching and canonical `Allow` calculation.
5. **Transport & Web bridging**: `SsrWebHttpRuntime.ts` for body stream bridging, native Request creation, native Response streaming, and unread body draining.
6. **Middleware runtime**: `SsrServerMiddlewareRuntime.ts` for chaining, `next()`, short-circuiting, and unwinding.
7. **SsrRequestHandler integration**: Embed the authoritative pipeline in `src/server/SsrRequestHandler.ts`.
8. **SEO & legacy endpoints integration**: Update static ownership sets in `SeoEndpoints.ts`.
9. **Public & package exports**: Update `src/index.ts`, `src/SsrPublicApi.test.ts`, `scripts/SsrPackageArtifact.mjs`.
10. **Example migration**: Update `examples/1-single-app/server/products.ts` and `server.ts`.
11. **useFetch test migration**: Update products endpoint fetch test to route test.
12. **Documentation & tests**: Update `README.md` and write all unit/integration tests.

---

# 44. Relevant Existing Files

Primary files expected to change:
- `src/SsrConfigTypes.ts`
- `src/SsrConfigCompileRuntime.ts`
- `src/SsrConfigCompileBoundary.ts`
- `src/SsrUniversalProjection.ts`
- `src/SsrRuntimeTypes.ts`
- `src/server/SsrRequestHandler.ts`
- `src/server/SsrServerRuntime.ts`
- `src/server/SsrCompiledMetadata.ts`
- `src/extensions/seo/SeoEndpoints.ts`
- `src/index.ts`
- `src/server.ts`
- `src/SsrPublicApi.test.ts`
- `scripts/SsrPackageArtifact.mjs`
- `scripts/SsrPackageSmoke.mjs`
- `README.md`
- `examples/1-single-app/server.ts`
- `examples/1-single-app/server/products.ts`
- `examples/1-single-app/README.md`
- `src/data/fetch/__tests__/SsrFetchProductsEndpoint.test.ts`
- `doc/server-api-plan/serverRoutes.plan.md` (canonical plan)

New files to create:
- `src/server-routes/SsrServerRouteTypes.ts`
- `src/server-routes/defineServerRoutes.ts`
- `src/server-routes/defineServerMiddleware.ts`
- `src/server-routes/SsrServerRouteRuntime.ts`
- `src/server-routes/SsrServerMiddlewareRuntime.ts`
- `src/server-routes/index.ts`
- `src/server/SsrWebHttpRuntime.ts`

---

# 45. Architectural Constraints

- **No learning-curve inflation**: Native Web standards (`Request`, `Response`, `URL`, `Headers`, `ReadableStream`).
- **Browser-safe exports**: Root exports must not pull Node or server runtime into universal bundles.
- **Server-only means server-only**: Server routes and middleware must never be projected into client assets.
- **No request globals**: Fresh, isolated context per request.
- **Deterministic routing**: Pure path-first matching; zero dependence on registration order.
- **Framework owns HTTP mechanics**: Automatic OPTIONS, GET-backed HEAD, 405 Method Not Allowed, Allow header calculation, unread body draining.
- **Application owns business policy**: Body parsing, auth logic, domain validation, database calls.

---

# 46. Implementation Discipline

The architecture and public API are approved. Do not redesign the API or introduce alternative abstractions.

### Coding-only instruction:
Write and generate the implementation code, type definitions, tests, examples, and documentation only. Do **NOT** run validation commands (`npm test`, `vitest`, `npm run build`, `tsc`, `eslint`, `git`, etc.). The repository owner will run all validation commands after completion.

---

# Final Expected Outcome

After `task-006`, an application developer should be able to write:

```ts
import { defineServer, defineServerMiddleware, defineServerRoutes } from 'vue-ssr-lite'

const authMiddleware = defineServerMiddleware<{
  user: User
}>(async (request, context, next) => {
  const user = await authenticate(request)

  if (!user) {
    return Response.json(
      {
        error: 'Unauthorized.',
      },
      {
        status: 401,
      }
    )
  }

  context.user = user

  return next()
})

const productsRoutes = defineServerRoutes({
  prefix: '/api/products',

  middleware: [authMiddleware],

  routes: {
    '/': {
      GET() {
        return Response.json({
          products: [],
        })
      },
    },

    '/:id': {
      GET(request, context) {
        return Response.json({
          id: context.params.id,
          user: context.user,
        })
      },
    },
  },
})

export default defineServer({
  render: 'ssr',

  serverRoutes: [productsRoutes],
})
```

without:
- endpoint IDs
- `ownedPaths`
- manual `match()` callbacks
- manual `JSON.stringify()`
- manual `Content-Type`
- manual HEAD handling
- manual OPTIONS handling
- manual 405 handling
- custom Request / Response wrappers
- DI containers or controllers

That simplicity is the success criterion.
