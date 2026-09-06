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
defineServerMiddleware<Provides, Requires>()
```

The public mental model must remain:

```text
Request
  ↓
serverMiddleware
  ↓
serverRoute path matching
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

That internal ordering is useful and must inform the new architecture:

```text
server routes
→ do NOT consume Vue SSR admission capacity
→ may own HTTP paths before Vue rendering
→ must coexist correctly with SEO-owned HTTP resources
```

Do not implement server routes as Vue routes and do not send them through Vue SSR admission.

## 1.3 Built-in SEO currently uses endpoint ownership

Built-in `/robots.txt` and `/sitemap.xml` behavior is compiled through internal endpoints.

The compiler currently gives `createSeoEndpoints()` the consumer endpoint collection so exact `ownedPaths` can suppress built-in SEO resources.

SEO tests explicitly verify that consumer ownership of `/robots.txt` or `/sitemap.xml` prevents the built-in resource from being created without executing arbitrary endpoint match predicates during compilation.

The new server-route implementation must preserve this ownership behavior.

## 1.4 Request lifecycle

Current `SsrRequestHandler.ts` already owns:

```text
Vite fallthrough
→ runtime/config loading
→ health/readiness
→ private resource protection
→ trusted host/proxy normalization
→ application host selection
→ domain resolution
→ publicConfig
→ site origin
→ SEO
→ endpoint dispatch
→ production assets
→ non-HTML 404
→ SPA/SSR
```

Do not replace this request handler with another server.

Integrate the server-route pipeline into it.

## 1.5 Existing cancellation

The managed Node server already creates one canonical `SsrRequestScope`, cancels it when the incoming request is aborted or the outgoing response closes prematurely, and passes that signal through Core.

The native Web `Request.signal` created for server routes must use this same signal.

Do not introduce another independent AbortController.

---

# 2. Public API Contract

Implement these new root runtime exports:

```ts
defineServerRoutes
defineServerMiddleware
```

They must be importable from:

```ts
import { defineServer, defineServerRoutes, defineServerMiddleware } from 'vue-ssr-lite'
```

The root package currently exports `defineServer`, `defineApplication`, `defineMiddleware`, `useFetch`, navigation APIs, SEO APIs, etc. Extend this surface deliberately rather than exposing internal route compiler/runtime helpers.

Supporting **type-only** exports may be added where required for declaration quality, for example:

```ts
ServerMiddleware
ServerRouteContext
ServerRoutesDefinition
```

but do not introduce additional runtime functions.

Do NOT publicly export runtime implementation helpers such as:

```text
compileServerRoutes
matchServerRoute
dispatchServerRoute
createWebRequest
executeServerMiddleware
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

Current normalized/compiled configuration explicitly carries `endpoints`, Vue middleware, routes, SEO, cache policy, etc.; server routes must become another server-only compiled application property rather than being attached to the Vue application definition.

---

# 5. Strict Server-Only Compilation Boundary

This is critical.

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

The existing universal projection explicitly projects universal fields such as Vue middleware and extensions. Do **not** add `serverRoutes` or `serverMiddleware` to that projection list.

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

---

# 6. Recommended Internal File Ownership

Keep the implementation modular but small.

Recommended structure:

```text
src/
└── server-routes/
    ├── SsrServerRouteTypes.ts
    ├── defineServerRoutes.ts
    ├── defineServerMiddleware.ts
    ├── SsrServerRouteRuntime.ts
    ├── SsrServerMiddlewareRuntime.ts
    └── index.ts
```

Transport-specific Web API bridging should remain under the existing server layer:

```text
src/server/
└── SsrWebHttpRuntime.ts
```

or equivalent.

Responsibilities:

### `SsrServerRouteTypes.ts`

Own:

```text
public handler types
middleware phantom metadata
Provides/Requires extraction
context composition
path-param extraction
method entry types
route-group types
compiled internal route types
```

### `defineServerMiddleware.ts`

Typed identity/helper for HTTP middleware.

No business logic.

### `defineServerRoutes.ts`

Typed identity/helper for route groups.

Preserve literal:

```text
prefix
route keys
middleware tuple ordering
method keys
```

with const generics.

### `SsrServerRouteRuntime.ts`

Own:

```text
path normalization
route compilation
collision validation
static/dynamic matching
param extraction
HTTP method resolution
Allow calculation
dispatch
```

### `SsrServerMiddlewareRuntime.ts`

Own:

```text
middleware execution
context mutation
next() continuation
double-next protection
short-circuit handling
reverse unwind
```

### `SsrWebHttpRuntime.ts`

Own:

```text
IncomingMessage → native Request bridge
native Response → ServerResponse streaming bridge
legacy SsrHttpResponse → native Response adaptation where required
```

Do not put all server-route behavior directly inside `SsrRequestHandler.ts`.

---

# 7. `defineServerMiddleware<Provides, Requires>()`

The exact generic order is approved:

```ts
defineServerMiddleware<Provides, Requires>()
```

`Provides` comes first.

## 7.1 Provides

Example:

```ts
const authMiddleware = defineServerMiddleware<{
  user: AuthenticatedUser
}>(async (request, context, next) => {
  const user = await authenticate(request)

  if (!user) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  context.user = user

  return next()
})
```

Inside the middleware itself:

```text
Requires
→ guaranteed/readable

Provides
→ writable, but must NOT be considered already guaranteed
```

Conceptually, the middleware callback context is:

```ts
;BaseContext & Requires & Partial<Provides>
```

This prevents:

```ts
context.user.id
```

from being incorrectly considered safe before the auth middleware assigns `context.user`.

Downstream middleware/handlers see:

```ts
;BaseContext & Requires & Provides
```

## 7.2 Requires

Requires can include both business context and framework route context.

Example:

```ts
const productMiddleware =
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

This means the middleware is legal only when all required values already exist.

## 7.3 Ordered middleware composition

Middleware tuples must compose left-to-right.

Given:

```ts
middleware: [authMiddleware, adminMiddleware]
```

if:

```text
auth:
  Provides user

admin:
  Requires user
  Provides isAdmin
```

the chain is valid.

This must fail at TypeScript level:

```ts
middleware: [adminMiddleware, authMiddleware]
```

because `user` does not exist before `adminMiddleware`.

## 7.4 Duplicate Provided keys

A middleware must not provide a key already supplied by:

```text
framework base context
earlier group middleware
earlier path middleware
earlier method middleware
```

Example:

```text
authMiddleware
  Provides user

secondMiddleware
  Provides user

→ invalid
```

Do not silently intersect or overwrite duplicate types.

Do not allow middleware to provide framework-owned keys:

```text
requestId
params
```

Use invariant phantom typing/branding so assignability cannot accidentally make incompatible middleware appear compatible.

---

# 8. Global `serverMiddleware` Type Restriction

Global server middleware is intentionally cross-cutting only.

Valid examples:

```text
logging
tracing
CORS
security headers
timing
response headers
```

It must not become an implicit source of typed route business state.

Therefore this must be rejected by the `serverMiddleware` config type:

```ts
serverMiddleware: [
  authMiddleware, // Provides user → invalid globally
]
```

Likewise a global middleware must not require:

```text
params
user
tenant
workspace
permissions
```

because none of those are pre-route guarantees.

Global middleware receives pre-route context such as:

```ts
context.requestId
```

but not:

```ts
context.params
```

Use the same `defineServerMiddleware()` function; do not create another helper such as `defineGlobalServerMiddleware()`.

The restriction belongs in the `serverMiddleware` configuration type.

---

# 9. Route Context

Use one fresh mutable context object per request.

No process-global or module-global request state.

Before route matching:

```ts
{
  requestId
}
```

After a route is matched:

```ts
{
  requestId,
  params,
  ...middlewareProvidedValues
}
```

Framework-owned values should be non-replaceable.

At minimum:

```text
requestId
params
```

must be framework-owned.

`params` should be an immutable/read-only snapshot from the consumer perspective.

Business context remains mutable so middleware can assign:

```ts
context.user = user
context.product = product
```

Do not turn context into:

```text
dependency container
service registry
Map
set/get API
```

Long-lived dependencies remain ordinary imports.

---

# 10. Type-Safe Route Params

Params are inferred from:

```text
prefix + child route path
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

Both values must infer as:

```ts
string
```

This must fail:

```ts
context.params.id
```

## Middleware scope rules

### Group middleware

Can require params from:

```text
prefix only
```

Example:

```text
prefix:
  /organizations/:organizationId
```

Group middleware can require:

```text
organizationId
```

but not a later child:

```text
productId
```

### Path middleware

Can require params from:

```text
prefix + path
```

### Method middleware

Can require the same final params as path middleware:

```text
prefix + path
```

These rules must be enforced statically through tuple/context composition.

---

# 11. Route Path Grammar

Keep v1 intentionally small.

Support:

```text
/static/path
/:param
/users/:userId
/organizations/:organizationId/users/:userId
```

Parameter names should use a simple identifier grammar, for example:

```text
[A-Za-z_][A-Za-z0-9_]*
```

Do NOT support in this task:

```text
:id?
*
**
:id(regex)
[...slug]
[[...slug]]
```

Also reject:

```text
query strings in route declarations
hashes
duplicate parameter names
empty parameter names
malformed path declarations
```

Prefer rejecting ambiguous double-slash/dot-segment declarations rather than silently inventing normalization behavior.

---

# 12. Path Normalization

Freeze these semantics:

```text
/api/products
/api/products/
```

are the same route.

Paths otherwise remain case-sensitive:

```text
/Products
/products
```

are different.

Param values are decoded exactly once.

Malformed percent encoding must produce a controlled client error before route middleware or the handler runs.

Use:

```text
400 Bad Request
```

for malformed route encoding.

Do not expose partially decoded params.

Encoded values remain application input and applications remain responsible for domain validation.

---

# 13. Route Compilation

Compile server-route groups when the server configuration is compiled/reloaded.

Do not rebuild route matcher structures on every request.

Each selected application should receive an immutable compiled server-route table.

Flatten:

```text
group prefix
+ child path
+ path middleware
+ HTTP methods
+ method middleware
+ handler
```

into deterministic compiled records.

Preserve handler and middleware function references.

Precompute where practical:

```text
normalized path
static/dynamic segments
structural collision key
param names
HTTP method map
Allow methods
exact owned paths
precedence metadata
```

Development config reload should naturally compile a new immutable route table alongside the new config revision.

Never mutate a route table already being used by an in-flight request.

---

# 14. Route Collision Rules

Collision detection must be deterministic and independent of import/registration order.

## Static routes

If two route groups declare the same normalized static:

```text
METHOD + path
```

for the same application, throw a configuration error.

Example:

```text
GET /api/products
GET /api/products
→ configuration error
```

Disjoint methods on the same exact static path may be compiled into the same path ownership set, provided each method has exactly one unambiguous middleware/handler chain.

## Dynamic structural routes

These conflict:

```text
/users/:id
/users/:name
```

because they have the same structural matching pattern with different param identities.

Reject structurally equivalent dynamic route declarations within one application rather than depending on registration order.

## Static outranks dynamic

Given:

```text
/products/new
/products/:id
```

request:

```text
/products/new
```

must select the static route.

## Framework control paths

A server route must not silently shadow configured:

```text
healthPath
readinessPath
```

Those are framework control-plane endpoints.

Detect obvious static collisions and report a clear configuration error.

## Multi-app

Do not report collision between:

```text
app A: GET /api/products
app B: GET /api/products
```

because host/application selection scopes their route tables independently.

---

# 15. HTTP Method Model

Support the normal server-route methods:

```text
GET
POST
PUT
PATCH
DELETE
HEAD
OPTIONS
```

Keep method keys uppercase.

Do not add method helper functions such as:

```text
get()
post()
route.get()
```

## Direct handler

```ts
GET(request, context) {
  return Response.json(...)
}
```

## Configured method

```ts
DELETE: {
  middleware: [
    adminMiddleware,
  ],

  handler(request, context) {
    return Response.json(...)
  },
}
```

Do not require object configuration when no method-specific configuration exists.

---

# 16. HTTP Method Resolution Must Happen Before Route Middleware

Once a path is owned, resolve the method before running:

```text
group middleware
path middleware
method middleware
```

Required behavior:

```text
path matched
+ method supported
→ execute route chain

path matched
+ unsupported method
→ 405

OPTIONS
+ no explicit OPTIONS
→ automatic OPTIONS

HEAD
+ no explicit HEAD
+ GET exists
→ GET fallback

no path match
→ continue normal vue-ssr-lite application pipeline
```

Example:

```text
PUT /api/products
```

against:

```text
GET /api/products
POST /api/products
```

must return:

```text
405 Method Not Allowed
```

without running `authMiddleware`.

Automatic OPTIONS must likewise not enter group/path/method middleware.

Global `serverMiddleware` has already entered because it is outside route-method resolution.

---

# 17. `Allow` Header

For a matched path, calculate one deterministic `Allow` header.

It should include:

```text
explicit methods
HEAD when GET makes HEAD available
OPTIONS because Core provides automatic OPTIONS
```

Example:

```text
GET
POST
```

should produce an Allow equivalent to:

```text
GET, HEAD, POST, OPTIONS
```

Use one stable method ordering so output is deterministic.

For automatic OPTIONS:

```text
status: 204
body: none
Allow: ...
```

For unsupported methods:

```text
status: 405
body: framework-controlled small response or empty response
Allow: ...
```

Do not fall through to Vue or a legacy endpoint after a server-route path has claimed ownership.

---

# 18. HEAD Semantics

If explicit HEAD exists:

```ts
HEAD() {}
```

use it.

Otherwise if GET exists:

```text
HEAD
→ resolve to GET route definition
→ run GET's group/path/method middleware
→ run GET handler semantics
→ strip response body at transport
```

The incoming native Request must still report:

```ts
request.method === 'HEAD'
```

Do not mutate it to GET.

This preserves native request semantics while giving GET-backed HEAD behavior.

---

# 19. Native Web `Request`

Handlers and HTTP middleware receive a real native Web `Request`.

Do not wrap or mutate it.

The current normalized Core request contains method, URL metadata, and headers but no incoming body stream.

The Node transport must therefore bridge `IncomingMessage` into a Web-readable request body.

## Required Request properties

Preserve:

```text
absolute URL
method
headers
body stream
AbortSignal
```

Construct the absolute URL from Core's trusted host/protocol normalization rather than untrusted raw forwarded headers.

For GET/HEAD:

```text
body = undefined
```

For body-capable methods:

```text
IncomingMessage stream
→ Web ReadableStream
→ Request body
```

Node's fetch-compatible Request may require:

```ts
duplex: 'half'
```

when a streaming body is supplied.

Use the canonical `SsrRequestScope.signal` as:

```ts
request.signal
```

The current managed server already cancels this scope when the incoming request aborts.

Do not buffer request bodies in framework memory merely to provide `request.json()`.

## Body semantics

Native one-shot body semantics apply.

If middleware wants to inspect a body without consuming what the handler needs, it can use native:

```ts
request.clone()
```

Do not add:

```text
request.bodyObject
context.body
req.body
useBody()
```

---

# 20. Request Bodies Stay Application-Owned

The framework must not add a schema/validation DSL.

Application code should continue:

```ts
const input: unknown = await request.json()

if (!isCreateProductInput(input)) {
  return Response.json({ error: 'Invalid product.' }, { status: 400 })
}
```

Applications may choose:

```text
Zod
Valibot
TypeBox
ArkType
manual validation
other libraries
```

No framework dependency should be added for body validation.

Do not automatically coerce network JSON into the handler's business type.

---

# 21. Native Web `Response`

Server route handlers and server middleware return real native `Response` objects.

Examples:

```ts
Response.json(...)
Response.redirect(...)
new Response(...)
```

No custom response object is allowed for the new public route API.

Do not add:

```text
ctx.json()
send()
res.status()
{ statusCode, body }
```

to the new route surface.

Legacy internal `SsrHttpResponse` may continue to exist for existing SSR/SEO/cache internals.

The new HTTP route API must not expose it.

---

# 22. Native Response → Node Transport

Implement a proper native Response writer in:

```text
src/server/
```

Requirements:

```text
preserve status
preserve statusText where appropriate
preserve headers
preserve repeated Set-Cookie
stream body with backpressure
respect HEAD
respect cancellation
do not buffer streams by default
```

The current `sendResponse()` only writes the internal `SsrHttpResponse` body directly.

Add a Web Response path rather than converting every native response through:

```ts
await response.arrayBuffer()
```

That would destroy streaming semantics and increase memory usage.

Use Node/Web stream bridging and `pipeline()` where appropriate.

For HEAD:

```text
send status + headers
do not emit body bytes
release/cancel body stream safely
```

For repeated Set-Cookie, use the platform's `Headers.getSetCookie()` where supported instead of collapsing cookies into a comma-joined header.

If a handler returns a consumed/invalid response body or the stream fails, use the existing request error/cancellation behavior rather than silently sending corrupted data.

---

# 23. Legacy `SsrHttpResponse` Interoperability

Do not rewrite every existing SSR subsystem to native Response in this task.

Keep:

```text
SSR render response cache
SEO internals
renderError
existing SsrHttpResponse-based helpers
```

working.

Add a controlled internal adapter:

```text
SsrHttpResponse
→ native Response
```

when a legacy downstream response must unwind through `serverMiddleware`.

Preserve:

```text
status code
headers
repeated headers
body bytes
```

Do not expose this adapter publicly.

---

# 24. Server Middleware Runtime

Middleware signature:

```ts
async (
  request,
  context,
  next,
) => {
  ...
}
```

Continuation:

```ts
return next()
```

Short-circuit:

```ts
return new Response(...)
```

## Execution

Global:

```text
serverMiddleware
```

then, after route/method resolution:

```text
group
→ path
→ method
→ handler
```

## Reverse unwind

Given:

```text
A
B
C
handler
```

response execution is:

```text
handler
→ C
→ B
→ A
```

so middleware can do:

```ts
const response = await next()

console.log(response.status)

return response
```

## Double next guard

Each middleware may call its `next()` at most once.

A second invocation must reject with a deterministic framework error.

Do not permit duplicated handler execution.

## Short-circuit

If middleware returns a Response without `next()`:

```text
all deeper middleware
handler
```

must not execute.

Earlier middleware still unwinds normally.

---

# 25. Actual Request-Handler Integration

Update:

```text
src/server/SsrRequestHandler.ts
```

Do not rewrite the whole file.

Refactor the current linear application lifecycle into a continuation that the new global HTTP middleware can wrap.

Preserve transport/control-plane ownership first:

```text
Vite development middleware
health endpoint
readiness endpoint
private build metadata/path protections
```

These existing framework/transport paths should not become dependent on user application auth middleware.

Then:

```text
normalize trusted host/protocol
select application/host
identify server-route ownership
```

Create the native Request and pre-route context before executing user `serverMiddleware`.

### Important static asset consideration

Existing production assets stream directly through `ServerResponse` and intentionally bypass `SsrHttpResponse` buffering. Do not accidentally force static-file streams through a buffered Web Response conversion just to support middleware.

Preserve the existing direct static streaming architecture.

A pure server-route ownership preflight may be performed before static-file serving so an application server route can still own a matching path, as legacy endpoints currently do.

Transport-owned static asset responses do not need to become business HTTP routes.

### Application continuation

For application-owned requests, global server middleware should wrap:

```text
serverRoutes
legacy app endpoint compatibility
non-HTML application responses
SPA/SSR application response
```

where technically feasible without breaking direct static streaming.

The final observable server-route behavior must match the approved blueprint even if the internal handler uses precomputed ownership metadata.

---

# 26. Server Route Dispatch Order Relative to Existing Endpoints

`serverRoutes` becomes the canonical ordinary application HTTP API.

Dispatch it before legacy consumer endpoint matching.

Required order after application selection:

```text
serverRoute path ownership
→ serverRoute HTTP method resolution
→ serverRoute dispatch

if NO serverRoute path matches:
→ legacy internal/compatibility endpoint pipeline
→ production asset
→ normal SPA/SSR handling
```

If a server-route path matches but method does not:

```text
405
```

Do not allow a legacy endpoint or Vue route to handle it afterward.

---

# 27. Legacy `endpoints` Compatibility

Do not delete the existing internal endpoint implementation in this task.

It is currently used by:

```text
built-in SEO
advanced server helpers
existing tests
possibly existing consumers
```

The public `vue-ssr-lite/server` entry currently exposes `SsrEndpointDefinition`, `SsrEndpointTools`, and `createSsrSeoEndpoints`.

For this implementation:

1. `serverRoutes` becomes the documented/recommended application API.
2. Migrate first-party ordinary examples away from consumer `endpoints`.
3. Do not add new endpoint features.
4. Keep internal/legacy endpoint compatibility unless a separate breaking cleanup task explicitly removes it.
5. Do not make application developers use endpoint IDs or ownedPaths when using the new API.

This keeps this task focused and avoids combining a new API implementation with an unrelated breaking-removal migration.

---

# 28. SEO Ownership Integration

A server route declaring:

```text
/robots.txt
```

or:

```text
/sitemap.xml
```

must be able to own that path.

The route compiler should expose exact static path ownership to the SEO compiler.

Do not execute route handlers or middleware during config compilation.

Do not execute dynamic route matching predicates during SEO compilation.

Recommended internal model:

```text
compiled server-route exact owned paths
+
legacy endpoint ownedPaths
→ SEO ownership set
```

Then built-in SEO creation checks this ownership declaration.

If a server route owns `/robots.txt` but only declares POST:

```text
GET /robots.txt
→ server-route path ownership
→ 405
```

Do not silently fall back to built-in robots behavior.

Path ownership occurs before method fallback.

Preserve existing static physical-file behavior where applicable.

---

# 29. Multi-Application Behavior

After host selection:

```text
request host
→ application
→ that application's compiled serverRoutes only
```

A route group from application A must never execute for application B.

Context and middleware state must be fresh per request even when:

```text
same process
same route definition
concurrent requests
different hosts
```

No request context may be stored on compiled route definitions.

Compiled route tables may be shared because they are immutable.

Request state may not.

---

# 30. Interaction with SSR Admission

Server routes must not consume:

```text
maxConcurrentSsrRequests
maxQueuedSsrRequests
```

Those limits are specifically for Vue SSR work.

Current custom endpoints already bypass SSR admission. Preserve that behavior for server routes. The README explicitly states that custom endpoints, SPA HTML, assets, health/readiness, and cache hits bypass Vue SSR capacity.

Only requests that actually fall through to Vue SSR should acquire an SSR admission lease.

---

# 31. Error Behavior

A server route/middleware may intentionally return:

```ts
Response.json({ error: 'Forbidden.' }, { status: 403 })
```

That is a normal response.

If handler or middleware throws/rejects and nobody catches it:

```text
throw / rejection
→ existing framework request error handling
→ HTTP 500
```

The current request handler already centralizes timeout/internal failures and uses `renderError` where configured. Preserve that mechanism rather than adding a route-error DSL.

Middleware may naturally handle downstream failure:

```ts
try {
  return await next()
} catch (error) {
  ...
}
```

If it returns a Response, that response is authoritative.

No:

```text
defineServerErrorHandler()
RouteError
HttpException DSL
controller exception filter
```

in this task.

---

# 32. Cancellation & Timeout

All server middleware and route handlers must observe the existing request-wide deadline.

Native Request:

```ts
request.signal
```

must be the canonical request signal.

If:

```text
client disconnects
request timeout occurs
server shuts down/cancels request
```

the same signal aborts.

Do not create nested timeout signals for server routes.

Applications may compose their own signal if needed, but Core's request signal remains authoritative.

Streaming response transport must also stop when the canonical scope aborts.

---

# 33. Query Parameters

Do not add:

```text
context.query
request.query
```

Handlers use:

```ts
const url = new URL(request.url)

const page = url.searchParams.get('page')
```

The URL must be absolute and use Core's trusted host/protocol result.

---

# 34. Dependency Model

Explicitly preserve:

```text
database
Redis
mailer
storage
repositories
API clients
services
→ normal ES imports
```

Example:

```ts
import { db } from '../db'
```

Do not create:

```text
serverContext()
dependency providers
inject()
container.bind()
service decorators
```

Request-specific business values belong in middleware context.

---

# 35. Public Export Changes

Update:

```text
src/index.ts
```

to expose:

```ts
defineServerRoutes
defineServerMiddleware
```

and necessary type-only API.

Do not export internal matcher/compiler/transport functions.

Update:

```text
src/SsrPublicApi.test.ts
scripts/SsrPackageArtifact.mjs
scripts/SsrPackageSmoke.mjs
```

so packaged root API checks expect the new public functions.

The package smoke code currently enumerates expected root runtime exports explicitly, so this feature is incomplete if source works but packed-package checks still omit the new exports.

Do not add a new package subpath solely for server routes.

The approved import is:

```ts
from 'vue-ssr-lite'
```

---

# 36. Existing Single-App Example Migration

Update:

```text
examples/1-single-app/server/products.ts
```

from the current:

```ts
SsrEndpointDefinition
```

to the approved route-map API.

For example:

```ts
export const productsRoutes = defineServerRoutes({
  prefix: '/api/products',

  routes: {
    '/': {
      GET(request) {
        const failure = new URL(request.url).searchParams.get('fail') === 'true'

        return Response.json(
          failure
            ? {
                error: 'This is the example’s simulated failure.',
              }
            : {
                products,
              },
          {
            status: failure ? 503 : 200,
            headers: {
              'cache-control': 'no-store',
            },
          }
        )
      },
    },
  },
})
```

Then:

```ts
defineServer({
  ...
  serverRoutes: [
    productsRoutes,
  ],
})
```

Do not manually implement HEAD or 405 in the example anymore.

Core should demonstrate those automatically.

Update:

```text
examples/1-single-app/README.md
```

to call it a server route rather than a custom endpoint.

---

# 37. Approved Blueprint Documentation

Keep:

```text
doc/server-api-plan/server-api-example/
```

as the architecture/example reference.

Synchronize it only if implementation-level naming/type details require clarification.

Do not redesign the blueprint while coding.

Add the implementation plan itself at:

```text
doc/server-api-plan/serverRoutes.plan.md
```

using this task as the source.

Update the main:

```text
README.md
```

with a concise Server Routes section showing:

```text
defineServerRoutes
defineServerMiddleware
serverRoutes
serverMiddleware
native Request/Response
three route middleware scopes
```

Clearly distinguish:

```text
defineMiddleware()
→ Vue navigation

defineServerMiddleware()
→ server HTTP
```

---

# 38. useFetch Integration

The current `useFetch` feature uses the first-party example `/api/products` endpoint as its same-origin SSR demonstration.

Migrate:

```text
src/data/fetch/__tests__/SsrFetchProductsEndpoint.test.ts
```

to exercise the new first-party server route instead of directly calling `productsEndpoint.handle()`.

Rename the test if appropriate, e.g.:

```text
SsrFetchProductsServerRoute.test.ts
```

The behavior must remain:

```text
SSR useFetch
→ same-origin /api/products
→ real managed HTTP server
→ server route
→ response
→ SSR data
```

Do not couple `useFetch` internals to server routes.

They should communicate over ordinary HTTP exactly as independent features.

---

# 39. Required Runtime Tests to WRITE

Write/update tests for the following behavior.

Do not run them as part of this task.

## Route compilation

Cover:

```text
static path
dynamic path
prefix joining
trailing slash normalization
case sensitivity
static-over-dynamic precedence
duplicate static METHOD + path
dynamic structural collision
duplicate final param names
unsupported route syntax
cross-module collisions
multi-app isolation
```

## Type-safety

Cover:

```text
prefix param inference
child param inference
unknown params rejected
group middleware prefix params
path middleware final params
method middleware final params
Provides flowing downstream
Requires satisfied by earlier middleware
Requires failure when ordering is wrong
duplicate Provides rejected
framework key Provides rejected
method-only Provides unavailable in sibling GET handler
global serverMiddleware rejecting business Provides
global serverMiddleware rejecting route-specific Requires
```

## Middleware runtime

Cover:

```text
server → group → path → method → handler order
reverse unwind
short-circuit
double next rejection
async middleware
sync middleware
thrown middleware error
thrown handler error
fresh context per concurrent request
```

## HTTP methods

Cover:

```text
explicit GET
POST
PUT
PATCH
DELETE
explicit HEAD
GET-backed HEAD
explicit OPTIONS
automatic OPTIONS
405
Allow header
method resolution before auth middleware
```

## Request

Cover:

```text
absolute URL
query string
headers
request.method
request.signal
JSON body
text body
formData where supported
streaming body
client disconnect cancellation
```

## Response

Cover:

```text
Response.json
text Response
204
redirect
custom headers
multiple Set-Cookie
streaming response body
HEAD body suppression
stream failure
abort during stream
```

## Core integration

Cover:

```text
server route bypasses Vue SSR admission
no route match falls through to normal Vue handling
matched path + wrong method does NOT fall through
server route beats Vue path ownership
server route before legacy endpoint on owned path
unmatched server route allows legacy endpoint
server route ownership before production asset fallback
```

## SEO

Cover:

```text
server route /robots.txt suppresses built-in robots
server route /sitemap.xml suppresses built-in sitemap
ownership check does not execute route handlers/middleware
```

## Config/browser boundary

Cover:

```text
serverRoutes may import node:fs
serverRoutes may import database-only module
serverMiddleware may import Node/server-only module
none enters generated client runtime
SPA app browser projection does not include serverRoutes
multi-app application serverRoutes remain server-only
```

## Packaging

Cover:

```text
root imports defineServerRoutes
root imports defineServerMiddleware
type declarations are self-contained
package contains no internal source paths
```

---

# 40. Acceptance Criteria

The implementation is complete only when all of the following are true.

### Public API

```ts
import { defineServer, defineServerRoutes, defineServerMiddleware } from 'vue-ssr-lite'
```

is the canonical application API.

### Route definition

The approved v8 blueprint compiles without application-side casts or manual context annotation.

### Params

Exact param names infer automatically from:

```text
prefix + child path
```

### Middleware

Provides/Requires composition works across:

```text
group
path
method
```

with ordered dependency checking.

### Global server middleware

It is pre-route, has no typed params/business state, and cannot provide business context to route modules.

### Native Request

POST/PATCH/PUT handlers can call:

```ts
await request.json()
```

against a real incoming managed-server request.

### Native Response

Handlers can return:

```ts
Response.json(...)
new Response(...)
Response.redirect(...)
```

without adapters in application code.

### Streaming

Neither incoming nor outgoing server-route bodies are obligatorily buffered by Core.

### Method semantics

Core automatically handles:

```text
HEAD fallback
OPTIONS
405
Allow
```

before route middleware.

### Route ownership

A matched server-route path never falls through to Vue due only to an unsupported HTTP method.

### Multi-app

Only the host-selected application's route table is eligible.

### SEO

Application-owned `/robots.txt` and `/sitemap.xml` suppress corresponding built-ins deterministically.

### SSR limits

Server-route requests do not consume Vue SSR admission capacity.

### Browser isolation

DB, secrets, Node built-ins, and server route handlers are absent from client output/projection.

### Request isolation

No middleware-provided state leaks between concurrent requests.

### Example

`examples/1-single-app` uses `serverRoutes`, not manual endpoint boilerplate, for `/api/products`.

### useFetch

The existing products data-fetch example continues to work against the new route API over real same-origin HTTP.

### Existing Vue behavior

No regression is introduced into:

```text
defineMiddleware()
Vue Router
SSR rendering
SPA rendering
SEO
hydration
useFetch
navigation loading
multi-app host routing
response caching
production assets
```

---

# 41. Important Edge Cases

Pay particular attention to these cases during implementation:

```text
prefix '/' + child '/'
empty prefix + child '/api'
prefix ending '/'
trailing-slash duplicate
same static path from separate modules
static /new beside dynamic /:id
malformed % encoding
encoded dynamic values
HEAD request body semantics
GET handler returning a stream during HEAD fallback
OPTIONS on authenticated group
PUT on authenticated GET-only route
middleware short-circuit before body consumption
middleware consumes body before handler
request aborted while request.json() is reading
request aborted while response is streaming
Response with multiple Set-Cookie values
Response with no body
handler returns non-Response from JavaScript
middleware calls next twice
middleware throws after await next()
same route definitions on different applications
server route vs built-in SEO path
server route vs legacy endpoint
server route vs static production asset
server route import containing Node-only dependency
```

Use controlled framework errors for invalid route configuration.

Do not allow registration order to resolve ambiguity.

---

# 42. Non-Goals

Do NOT add in this task:

```text
file-based API routes
controllers
decorators
dependency injection
serverContext()
request.query
request.params mutation
context.query
context.body
custom JSON helpers
custom Response wrapper
schema validation framework
automatic Zod integration
OpenAPI generation
RPC
GraphQL integration
WebSocket routes
SSE-specific API
wildcard routes
catch-all routes
optional params
regex params
route naming
route reverse generation
per-route caching DSL
rate-limit DSL
body parser DSL
cookie helper DSL
mutation framework
new error/exception framework
```

Do not refactor unrelated Vue navigation middleware.

Do not rewrite SEO internals to the new public route API unless required for ownership integration.

Do not remove legacy endpoint compatibility as part of this implementation unless explicitly instructed in a separate breaking-cleanup task.

---

# 43. Implementation Order

Implement in this sequence to minimize architectural churn:

```text
1. public/type model
2. defineServerRoutes / defineServerMiddleware
3. config types + normalization
4. server-only compiler boundary
5. route compiler + collision validation
6. middleware type composition
7. route matcher/method resolver
8. Node → Web Request bridge
9. middleware runtime
10. route dispatch
11. Web Response → Node transport
12. SsrRequestHandler integration
13. multi-app scoping
14. SEO ownership integration
15. legacy endpoint coexistence
16. examples/useFetch migration
17. public/package exports
18. documentation
19. tests/fixtures
```

Do not start by modifying the example and then reverse-engineer Core around it.

The runtime architecture must come first.

---

# 44. Relevant Existing Files

Primary files expected to change:

```text
src/SsrConfigTypes.ts
src/SsrConfigCompileRuntime.ts
src/SsrConfigCompileBoundary.ts
src/SsrUniversalProjection.ts
src/SsrRuntimeTypes.ts
src/server/SsrRequestHandler.ts
src/server/SsrServerRuntime.ts
src/server/SsrCompiledMetadata.ts
src/extensions/seo/SeoEndpoints.ts
src/index.ts
src/server.ts
src/SsrPublicApi.test.ts
src/SsrConfigCompileBoundary.test.ts
src/SsrConfigCompileRuntime.test.ts
src/SsrUniversalProjection.test.ts
src/server/SsrRequestHandler.test.ts
src/server/SsrServerRuntime.test.ts
src/extensions/seo/Seo10Architecture.test.ts
scripts/SsrPackageArtifact.mjs
scripts/SsrPackageSmoke.mjs
README.md
examples/1-single-app/server.ts
examples/1-single-app/server/products.ts
examples/1-single-app/README.md
src/data/fetch/__tests__/SsrFetchProductsEndpoint.test.ts
doc/server-api-plan/server-api-example/README.md
```

Likely new files:

```text
src/server-routes/SsrServerRouteTypes.ts
src/server-routes/defineServerRoutes.ts
src/server-routes/defineServerMiddleware.ts
src/server-routes/SsrServerRouteRuntime.ts
src/server-routes/SsrServerMiddlewareRuntime.ts
src/server-routes/index.ts
src/server/SsrWebHttpRuntime.ts
doc/server-api-plan/serverRoutes.plan.md
```

Adjust exact internal filenames if the existing repository organization makes a slightly different split cleaner, but do not change the approved public API.

---

# 45. Architectural Constraints

These are non-negotiable.

### No learning-curve inflation

A Vue developer should be able to understand:

```ts
'/api/products/:id': {
  GET(request, context) {
    return Response.json({
      id: context.params.id,
    })
  },
}
```

without learning a framework-specific HTTP abstraction.

### Native platform first

Prefer standards:

```text
Request
Response
URL
URLSearchParams
Headers
AbortSignal
ReadableStream
```

### Server-only means server-only

No server route dependency may be projected into browser code.

### No request globals

Every request receives fresh context.

### Deterministic routing

Never rely on import order.

### Framework owns HTTP mechanics

Applications should not manually implement:

```text
HEAD fallback
OPTIONS
405
Allow
path precedence
route collision detection
param extraction
```

### Application owns business policy

Applications own:

```text
auth logic
database calls
body validation
permissions
tenant lookup
business error responses
```

---

# 46. Implementation Discipline

The architecture/API has already been approved.

**Do not research competing libraries.**

**Do not redesign the API.**

**Do not introduce alternative names or additional abstractions.**

In particular, do not replace the approved names:

```text
serverRoutes
serverMiddleware
defineServerRoutes
defineServerMiddleware
prefix
routes
middleware
handler
context.params
```

Do not turn this into Express, Fastify, Hono, Nitro, Nest, or a custom controller framework.

Use the approved blueprint as the contract and adapt the current Core architecture to support it cleanly.

## Coding-only instruction

Your responsibility in this task is to **write/generate the implementation code, type definitions, tests, examples, and documentation only**.

Do **NOT** run:

```text
npm test
vitest
npm run build
vite build
tsc
typecheck
eslint
prettier check
package smoke tests
npm pack
dev server
benchmarks
validation scripts
Git commands
```

Do not spend usage repeatedly running validation commands.

The repository owner will run all validation after your code changes are complete.

You may inspect/read repository source as needed to implement correctly, but after understanding the architecture, focus strictly on producing the code changes.

Do not weaken code or omit tests merely because you will not run them.

Write the implementation and test coverage as though the complete suite will be executed immediately afterward.

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

```text
endpoint ids
ownedPaths
match callbacks
manual JSON.stringify()
manual Content-Type
manual HEAD
manual OPTIONS
manual 405
custom Request
custom Response
DI container
controller layer
```

That simplicity is the success criterion.

The implementation must feel like native Web HTTP added cleanly to Vue SSR Lite, not like another framework embedded inside it.
