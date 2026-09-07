# task-008 — Add Global `setContext()` API for `useFetch` Request Context

## Objective & Overview

Implement a new first-party public API:

```ts
setContext()
```

that allows application code to set application-wide request context—initially global request headers—for all future `useFetch()` executions.

The primary goal is to eliminate repeated authentication, tenant, workspace, locale, or similar headers across every `useFetch()` call.

Target developer experience:

```ts
import { setContext } from 'vue-ssr-lite'

setContext({
  headers: {
    authorization: `Bearer ${token}`,
  },
})
```

After that, application code should simply use:

```ts
useFetch('/api/products')
useFetch('/api/profile')
useFetch('/api/orders')
```

without repeating:

```ts
headers: {
  authorization: `Bearer ${token}`,
}
```

When the user's authentication state changes, the application calls `setContext()` again.

Example logout:

```ts
setContext({
  headers: {},
})
```

This MUST replace the previous context and therefore remove the old authorization header.

Do not add a separate `clearContext()` API.

Do not add:

```ts
defineServer({
  fetch: {
    onRequest() {},
  },
})
```

The public mental model must remain:

```text
setContext()
    ↓
stored application request context
    ↓
future useFetch() executions
    ↓
request-local useFetch options
    ↓
native HTTP request
```

This is an additive public API. Do not redesign the existing `useFetch()` API.

# Technical Context & Existing Architecture

`vue-ssr-lite` already provides a first-party SSR-aware `useFetch()` implementation with:

- SSR execution
- hydration restoration
- browser navigation
- GET/HEAD support
- native request options
- request deduplication
- application cache
- reactive URL/variables
- `refresh()`
- request-safe private identity/fingerprinting
- automatic same-origin SSR forwarding of incoming cookies/authorization
- per-request `headers?: HeadersInit`

Relevant existing areas include:

```text
src/data/fetch/
├── composables/
│   └── useFetch.ts
├── runtime/
│   ├── SsrFetchRuntime.ts
│   ├── SsrFetchIdentity.ts
│   └── ...
├── types/
│   └── SsrFetchTypes.ts
└── index.ts

src/data/index.ts
src/index.ts

src/SsrReleaseContract.test.ts
scripts/SsrPackageArtifact.mjs
README.md

examples/4-server-api-app/
```

Before modifying code, inspect the current implementations and follow the existing fetch-runtime ownership/injection pattern rather than introducing a parallel runtime.

The existing request identity logic already normalizes `Headers`, automatically forwards same-origin SSR credentials when appropriate, and uses resolved request semantics for private request identity. Preserve those properties.

# Public API Contract

## New API

Expose from the normal root package:

```ts
import { setContext } from 'vue-ssr-lite'
```

Recommended public shape:

```ts
export interface SetContextOptions {
  headers?: HeadersInit
}

export function setContext(context: SetContextOptions): void
```

Do not require users to import the type for normal usage.

Example:

```ts
setContext({
  headers: {
    authorization: 'Bearer token',
    'x-workspace': 'workspace_123',
  },
})
```

# Replacement Semantics

This requirement is critical.

Every `setContext()` call MUST completely replace the previously stored global request context.

It MUST NOT permanently merge contexts across calls.

Example:

```ts
setContext({
  headers: {
    authorization: 'Bearer token',
    'x-workspace': 'workspace_1',
  },
})
```

Later:

```ts
setContext({
  headers: {
    'x-workspace': 'workspace_2',
  },
})
```

The resulting stored context must be equivalent to:

```text
x-workspace: workspace_2
```

and MUST NOT contain:

```text
authorization
```

because the second call replaced the first context.

Therefore logout works naturally:

```ts
setContext({
  headers: {},
})
```

No `clearContext()` API is required.

Also allow:

```ts
setContext({})
```

to represent an empty request context.

# Snapshot Semantics

`setContext()` must snapshot its input at call time.

Example:

```ts
const headers = new Headers({
  authorization: 'Bearer A',
})

setContext({ headers })

headers.set('authorization', 'Bearer B')
```

The stored context must still contain:

```text
Bearer A
```

until `setContext()` is explicitly called again.

Do not retain a caller-owned mutable `Headers`, object, array, or tuple structure by reference.

Normalize/copy it internally.

# Lifecycle Semantics

## Login

```ts
setContext({
  headers: {
    authorization: `Bearer ${token}`,
  },
})
```

Future `useFetch()` executions automatically receive the header.

## Token refresh

```ts
setContext({
  headers: {
    authorization: `Bearer ${newToken}`,
  },
})
```

Future executions use the new token.

## Workspace change

The caller supplies the complete desired context:

```ts
setContext({
  headers: {
    authorization: `Bearer ${token}`,
    'x-workspace': workspaceId,
  },
})
```

## Logout

```ts
setContext({
  headers: {},
})
```

Future requests must no longer contain the previous authorization/workspace headers.

# Existing Requests Must Not Be Mutated

Changing context only affects future request executions.

Example:

```text
Request A starts with token A
    ↓
setContext(token B)
    ↓
Request A continues with token A
    ↓
next request uses token B
```

Never mutate the `Headers` object of an already-created/in-flight physical request.

# Do Not Automatically Refetch Mounted Hooks

Calling:

```ts
setContext(...)
```

must NOT itself cause every active `useFetch()` consumer to refetch.

Context mutation is not reactive query invalidation.

Instead:

```text
setContext()
    ↓
stored context changes
    ↓
existing rendered data remains untouched
```

The new context is picked up when the hook executes again through:

- a new `useFetch()` call
- `refresh()`
- reactive URL change
- reactive variables change
- any normal new physical execution

For example:

```ts
setContext({
  headers: {
    authorization: `Bearer ${newToken}`,
  },
})

await profile.refresh()
```

`refresh()` must use the new context.

# Request Precedence

Global context acts as defaults.

Request-specific `useFetch()` options MUST have higher precedence.

Example:

```ts
setContext({
  headers: {
    authorization: 'Bearer default-token',
    'x-application': 'erp',
  },
})
```

Then:

```ts
useFetch('/api/admin', {
  headers: {
    authorization: 'Bearer admin-token',
  },
})
```

Final headers must contain:

```text
authorization: Bearer admin-token
x-application: erp
```

Therefore merge order should conceptually be:

```text
stored setContext headers
        ↓
per-useFetch headers
        ↓
existing normalization/security rules
        ↓
automatic SSR credential forwarding only when still absent
        ↓
final request identity
        ↓
fetch
```

Do not allow global defaults to unexpectedly overwrite explicitly supplied request-local values.

# Existing SSR Credential Forwarding

Preserve the current same-origin SSR behavior.

Today Core can automatically forward the incoming request's:

```text
cookie
authorization
```

for same-origin SSR `useFetch()` requests when those fields were not explicitly supplied and credentials are not omitted.

The new context layer must integrate with this instead of replacing it.

Required precedence:

```text
1. setContext defaults
2. per-useFetch headers override context
3. existing SSR forwarding fills cookie/authorization only if still absent
```

Examples:

### No context, no local authorization

```text
incoming SSR Authorization
    ↓
automatically forwarded
```

Existing behavior remains unchanged.

### Context contains authorization

```text
setContext Authorization
    ↓
SSR forwarding sees Authorization already exists
    ↓
does not overwrite it
```

### Local request contains authorization

```text
local useFetch Authorization
    ↓
wins over setContext
    ↓
SSR forwarding also does not overwrite it
```

# Same-Origin Security Boundary

Global application context MUST NOT silently leak authentication or tenant headers to unrelated external origins.

For v1, apply `setContext()` defaults only to same-origin `useFetch()` requests.

Example:

```ts
setContext({
  headers: {
    authorization: 'Bearer private-token',
  },
})
```

This should receive the context:

```ts
useFetch('/api/profile')
```

This should NOT automatically receive the context:

```ts
useFetch('https://third-party.example.com/data')
```

Cross-origin callers can still explicitly provide headers through the existing request-local API:

```ts
useFetch('https://third-party.example.com/data', {
  headers: {
    authorization: 'Bearer explicit-third-party-token',
  },
})
```

Do not add a `sameOriginOnly`, `scope`, `allowExternal`, or similar configuration option in this task.

Keep v1 secure and simple:

```text
global setContext → same-origin only
cross-origin      → explicit per-request headers
```

# `credentials: 'omit'`

Preserve the existing native request semantics.

`credentials: 'omit'` must continue to suppress Core's automatic forwarding of incoming SSR credentials.

Do not invent custom credential semantics outside normal request/header behavior.

The important invariant is that `setContext()` must flow through the same normalization/security pipeline as ordinary request headers rather than creating a privileged bypass.

# Runtime Ownership & SSR Safety

This is the most important implementation constraint.

DO NOT implement:

```ts
let currentContext = ...
```

as a Node process-global mutable singleton.

That would allow one SSR user's authentication context to leak into another concurrent request.

Context must belong to the active `vue-ssr-lite` application/fetch runtime.

## Server

Each SSR request must have its own context state:

```text
HTTP request A
   ↓
application runtime A
   ↓
context A

HTTP request B
   ↓
application runtime B
   ↓
context B
```

Concurrent SSR renders must never observe each other's context.

## Browser

The context belongs to the currently mounted vue-ssr-lite application runtime.

It should survive:

- component mounts/unmounts
- Vue Router navigation
- page component replacement
- normal `useFetch()` consumers

until:

- another `setContext()` replaces it
- the application runtime itself is disposed/recreated

# `setContext()` Must Work From Real Auth Flows

Do not implement `setContext()` using only:

```ts
getCurrentInstance()
```

or only component injection.

That is insufficient.

Authentication state commonly changes from:

```text
login click handler
logout click handler
Pinia/store action
async action called after setup
auth callback
application service
```

At those points Vue may not expose an active component instance.

The public requirement is:

> Once a vue-ssr-lite application runtime is active, `setContext()` can be called from normal application code and updates that application's stored request context.

Examples that must be supported:

```text
src/main.ts initializer
component setup
nested composable
component event handler
Pinia/store action triggered by the mounted application
login/logout flow after initial render
```

Do not force users to pass the Vue app instance into `setContext()`.

# Runtime Access Strategy

Before implementing this part, inspect how the current runtime establishes:

- active application ownership
- server request scope
- browser runtime lifecycle
- `SSR_FETCH_RUNTIME`
- user `main.ts` initialization
- app disposal

Reuse those mechanisms.

The implementation may introduce a small internal context-runtime bridge if necessary, but it must obey these constraints:

### Server

Runtime lookup must be request-scoped and safe under concurrent asynchronous SSR execution.

If the repository already has a request-local execution-scope mechanism, reuse it.

Do not create a second unrelated request-context mechanism unnecessarily.

If an AsyncLocalStorage-style primitive is genuinely required, keep Node-specific code out of the browser dependency graph.

### Browser

It is acceptable to bind the active mounted application's fetch runtime to a browser-side runtime accessor, because one selected vue-ssr-lite application owns the document.

However:

- bind explicitly during application startup
- replace/reset correctly during remount/HMR/test lifecycle
- clear on application disposal
- do not leave stale runtime references

### Initializer ordering

The runtime must already be available when the user's `main.ts` initializer executes.

This must work:

```ts
export default () => {
  setContext({
    headers: {
      'x-application': 'shop',
    },
  })
}
```

Do not require the first Vue component to mount before `setContext()` becomes usable.

# Invalid Usage

If `setContext()` executes when no vue-ssr-lite application/runtime is active, fail explicitly.

Do not silently create global state.

Use a descriptive error such as:

```text
setContext() requires an active vue-ssr-lite application.
```

Do not leak internal implementation terminology in the public error.

# Internal Context Storage

Prefer a small internal abstraction owned by the fetch/application runtime.

Conceptually:

```ts
interface StoredRequestContext {
  readonly headers: readonly [string, string][]
}
```

or another immutable/copy-safe representation.

The exact private representation is implementation-specific.

Required behavior:

```ts
runtime.setContext(input)
runtime.getContextSnapshot()
```

Each request execution must receive a fresh mutable native `Headers` instance constructed from the stored snapshot.

Do not expose internal storage publicly.

# Integration With `SsrFetchIdentity`

Context must be applied BEFORE the final physical-request fingerprint/cache identity is calculated.

This is mandatory.

Current useFetch has private identity/deduplication semantics based on request representation.

The final flow should be conceptually:

```text
resolve URL
    ↓
resolve variables
    ↓
resolve method/request options
    ↓
snapshot stored setContext state
    ↓
create final Headers
    ↓
merge context defaults
    ↓
merge request-local headers
    ↓
same-origin SSR credential forwarding
    ↓
existing sanitization/normalization
    ↓
calculate private request fingerprint
    ↓
cache/dedupe lookup
    ↓
physical fetch
```

Never do:

```text
calculate fingerprint
    ↓
add Authorization afterwards
```

That could cause requests for different authenticated identities to share a physical request/cache entry.

# Cache & Deduplication Requirements

Global context must affect private request identity exactly as equivalent request-local headers already do.

Example:

```ts
setContext({
  headers: {
    authorization: 'Bearer USER_A',
  },
})
```

```ts
useFetch('/api/profile')
```

Later:

```ts
setContext({
  headers: {
    authorization: 'Bearer USER_B',
  },
})
```

```ts
useFetch('/api/profile')
```

These MUST NOT incorrectly deduplicate/share an authenticated private representation.

However, do not expose raw authorization values through:

- public hydration keys
- DOM
- SSR payload
- diagnostics intended for the browser
- user-visible cache keys

Reuse the existing private fingerprint/security model rather than inventing a second cache identity.

# Hydration Security

The stored context itself MUST NOT be serialized into hydration state.

Especially do not serialize:

```text
Authorization
Cookie
x-api-key
workspace secrets
tenant credentials
```

Server context and browser context are separate runtime state.

Example:

```text
SSR runtime context
   ↓
used for SSR request execution
   ↓
NOT serialized as context

browser boots
   ↓
application may call setContext() using browser-safe auth state
```

If authentication uses HttpOnly cookies, the application may not need to call `setContext()` for auth at all because normal browser cookies and existing SSR forwarding already cover that flow.

Hydration should continue serializing only the existing safe fetch result/cache structures.

# Context Update and Existing Cache

Changing context does not require globally deleting the entire fetch cache.

Instead, the changed final request fingerprint must naturally separate incompatible request representations.

Do not implement broad cache clearing simply because `setContext()` changed.

Do not cause unrelated anonymous/public cache entries to disappear.

# Public Type Safety

Add appropriate public type coverage.

Required valid examples:

```ts
setContext({})
```

```ts
setContext({
  headers: {},
})
```

```ts
setContext({
  headers: {
    authorization: 'Bearer token',
  },
})
```

```ts
setContext({
  headers: new Headers({
    authorization: 'Bearer token',
  }),
})
```

```ts
setContext({
  headers: [['authorization', 'Bearer token']],
})
```

Invalid context properties should be rejected by TypeScript.

Do not add `any` to the public API.

# Explicit Non-Goals

Do NOT add any of the following in task-008:

```text
clearContext()
getContext()
useContext()
createFetchClient()
request client classes
Apollo Link-style chains
Axios-style interceptors
beforeFetch()
onRequest()
defineServer.fetch
defineApplication.fetch
globalThis.fetch monkeypatching
native fetch interception
POST/PATCH/DELETE support in useFetch
async context setter callback
automatic token refresh
automatic login/logout handling
automatic refetch after setContext()
persistent localStorage/sessionStorage context
context hydration/serialization
cross-origin global context
```

Also do not change Server Routes or Server Middleware APIs.

This task is only:

```text
stored application request context
+
setContext()
+
useFetch integration
```

# Native `fetch()` Boundary

`setContext()` must affect only first-party:

```ts
useFetch()
```

It MUST NOT monkeypatch or intercept:

```ts
fetch()
axios
Apollo Client
third-party API clients
```

For example:

```ts
setContext({
  headers: {
    authorization: 'Bearer token',
  },
})
```

affects:

```ts
useFetch('/api/products')
```

but does not magically modify:

```ts
fetch('/api/products')
```

This boundary must be documented clearly.

The existing Server API example uses native `fetch()` for mutations, so those mutation requests may still provide their own headers.

Do not broaden this task into a new imperative HTTP client.

# Suggested File-Level Implementation

Inspect the repository first and adapt paths if the current implementation has moved, but the expected areas are:

## `src/data/fetch/types/SsrFetchTypes.ts`

Add the public context input type:

```ts
export interface SetContextOptions {
  headers?: HeadersInit
}
```

Do not mix stored/internal representation types into this public file unless appropriate.

## New internal context runtime module

Prefer a focused internal module under the existing fetch feature, for example:

```text
src/data/fetch/runtime/SsrFetchContext.ts
```

Responsibilities:

- normalize/snapshot `SetContextOptions`
- store replacement context
- provide safe fresh snapshots per request
- own no process-global user context
- expose only internal runtime helpers

## `src/data/fetch/runtime/SsrFetchRuntime.ts`

Extend the existing per-app/per-request fetch runtime so it owns the current request context.

Responsibilities should include conceptually:

```ts
setContext(context)
getContextSnapshot()
```

Do not make context ownership a separate application singleton detached from the fetch runtime.

## `src/data/fetch/runtime/SsrFetchIdentity.ts`

Integrate stored context before final header/request fingerprint creation.

Preserve:

- native `Headers`
- proxy-authorization sanitization
- existing same-origin forwarding
- existing `credentials`
- existing cache identity behavior
- existing public/private identity split

## New public `setContext()` entry

Prefer a focused module such as:

```text
src/data/fetch/context/setContext.ts
```

or the nearest naming convention already used by the fetch feature.

Responsibilities:

- find the active application/fetch runtime
- replace its context
- throw when no runtime is active

Do not duplicate normalization logic here if the runtime owns it.

## `src/data/fetch/index.ts`

Export:

```ts
setContext
SetContextOptions
```

alongside `useFetch`.

## `src/data/index.ts`

Re-export the new public API/type.

## `src/index.ts`

Expose:

```ts
setContext
```

from the normal:

```text
vue-ssr-lite
```

entrypoint.

Do not put this API under:

```text
vue-ssr-lite/server
```

because it is universal application-facing functionality.

## Runtime/bootstrap integration

Inspect the code responsible for:

- creating `SsrFetchRuntime`
- providing `SSR_FETCH_RUNTIME`
- executing user `main.ts`
- browser app mount
- server render lifecycle
- application cleanup

Bind the active runtime so `setContext()` works from both initialization and later browser auth actions while preserving SSR isolation.

# Example Application Update

Update:

```text
examples/4-server-api-app/
```

to demonstrate the new feature.

Do not touch:

```text
examples/1-single-app/
```

unless an existing public release/type contract explicitly requires an additive assertion.

## Example initialization

The server API example currently uses public fixture tokens.

Use the new API to demonstrate global `useFetch()` authorization.

For example, from its universal application initialization:

```ts
import { setContext, type AppContext } from 'vue-ssr-lite'

export default (_context: AppContext) => {
  setContext({
    headers: {
      authorization: 'Bearer member-token',
    },
  })
}
```

This should make protected `useFetch()` calls work without request-local member headers.

## Remove repeated headers from `useFetch()`

Convert:

```ts
useFetch('/api/products', {
  headers: memberHeaders,
})
```

to:

```ts
useFetch('/api/products')
```

while preserving other options:

```ts
useFetch('/api/products', {
  variables: ...,
  fetchPolicy: ...,
  nextFetchPolicy: ...,
})
```

Do the same for:

```text
ProductsPage.vue
ProductPage.vue
OrganizationPage.vue
```

where applicable.

## Native mutation requests

Do NOT incorrectly remove auth headers from native mutation calls.

These remain native:

```ts
fetch(..., {
  method: 'POST'
})
```

so `setContext()` does not apply to them.

Keep their explicit fixture authentication where required.

The example README must explain this distinction.

## Logout documentation

Add a compact example:

```ts
setContext({
  headers: {},
})
```

Explain:

```text
setContext replaces the previous stored context.
Calling it with empty headers removes the previous global headers for future useFetch requests.
```

# README Documentation

Update the root README under Data Fetching.

Add a concise section such as:

```text
## Global request context
```

Document the normal pattern:

```ts
import { setContext } from 'vue-ssr-lite'

setContext({
  headers: {
    authorization: `Bearer ${token}`,
  },
})
```

Then:

```ts
useFetch('/api/profile')
```

Logout:

```ts
setContext({
  headers: {},
})
```

Document these exact semantics:

- context is application scoped
- each call replaces the previous context
- context affects future `useFetch()` executions
- existing in-flight requests are unchanged
- calling `setContext()` does not automatically refetch existing hooks
- `refresh()` uses the latest context
- request-local headers override context defaults
- context defaults are same-origin only
- native `fetch()` is unaffected
- SSR request state is isolated
- context itself is never hydrated/serialized

Add `setContext` to the API Reference table.

# Package / Release Contract

Update public export/package artifact assertions so `setContext` and its public type are included in the published package.

Relevant areas may include:

```text
src/SsrReleaseContract.test.ts
scripts/SsrPackageArtifact.mjs
```

Follow the same pattern already used for `useFetch`.

Do not create a new package subpath.

# Required Tests

Add focused automated coverage.

Do not rely only on example code.

## Public API / Type Tests

Verify:

- `setContext` exported from `vue-ssr-lite`
- `SetContextOptions` exported
- standard `HeadersInit` forms compile
- unknown context properties fail type checking
- no `any` leakage

## Replacement Behavior

Test:

```text
setContext(A)
setContext(B)

future request contains B
future request does not contain A-only headers
```

## Logout Behavior

Test:

```text
setContext({
  authorization
})

setContext({
  headers: {}
})

next request has no authorization from context
```

## Caller Mutation Isolation

Test:

```text
Headers A passed to setContext
caller mutates Headers A afterwards
stored context remains unchanged
```

## Per-Request Override

Test:

```text
context authorization = default
local useFetch authorization = override

final request = override
```

## Same-Origin

Verify context applies to:

```text
/api/products
https://current-origin.example/api/products
```

where appropriate.

Verify context does NOT automatically apply to:

```text
https://external.example/api
```

## Existing SSR Credential Forwarding

Ensure existing forwarding behavior remains intact when:

- no context header exists
- context authorization exists
- per-request authorization exists
- credentials are omitted

## Refresh

Test:

```text
setContext(token A)
initial request → A

setContext(token B)
refresh()
→ B
```

## No Automatic Refetch

Verify calling only:

```ts
setContext(...)
```

does not trigger a physical request for already-mounted consumers.

## In-Flight Snapshot

Test:

```text
request starts with A
setContext(B) before request settles
request still uses A
next execution uses B
```

## Cache / Deduplication Isolation

Verify two otherwise identical requests using different effective context headers cannot incorrectly share a private authenticated representation.

## Concurrent SSR Isolation

This test is mandatory.

Run two overlapping SSR request contexts conceptually:

```text
SSR A:
  setContext Authorization A
  useFetch /api/profile

SSR B:
  setContext Authorization B
  useFetch /api/profile
```

Force them to overlap asynchronously.

Assert:

```text
A receives only Authorization A
B receives only Authorization B
```

There must be no process-global leakage.

## Hydration Security

Verify stored context header values are not serialized into hydration output.

Specifically ensure raw secret values such as:

```text
Bearer secret-token
```

do not appear in the hydration payload merely because they were registered through `setContext()`.

## Browser Lifecycle

Verify:

- context persists across normal Vue Router navigation
- context survives component unmounts
- app disposal removes/replaces browser runtime association
- a newly created application does not inherit stale context from the previous app

## Invalid Runtime

Verify calling `setContext()` without an active vue-ssr-lite application fails with a clear public error.

# Edge Cases & Important Considerations

### Empty headers

These are valid and clear the previous context:

```ts
setContext({
  headers: {},
})
```

### Duplicate header casing

Native `Headers` semantics should normalize:

```text
Authorization
authorization
AUTHORIZATION
```

Do not implement custom case-sensitive header merging.

### `Headers` with repeated values

Follow native Web Headers behavior and the current fetch runtime conventions.

Do not introduce a custom multi-header format.

### Context change to identical values

This should be harmless.

No special event or forced refetch is required.

### Multiple sequential calls

Only the latest complete context remains stored.

### Context after logout

Old authorization values must be impossible to reappear from the context store unless explicitly set again.

Existing incoming cookie/authorization forwarding remains a separate existing SSR mechanism.

### Server/client separation

Never hydrate the server context object into the browser.

Never import server-only auth code into universal/browser bundles to implement this feature.

### Cross-origin security

Context defaults must not be projected onto arbitrary third-party origins.

# Architectural Constraints

Maintain the existing `vue-ssr-lite` philosophy:

```text
small
native
predictable
low learning curve
request safe
```

Use native:

```text
Headers
HeadersInit
Request
fetch semantics
```

Do not create:

```text
HeaderBag
RequestBuilder
ContextManager public class
Client instance
Link abstraction
Interceptor abstraction
```

# Expected End-State API

## Login

```ts
import { setContext } from 'vue-ssr-lite'

setContext({
  headers: {
    authorization: `Bearer ${token}`,
  },
})
```

## Normal page

```ts
const { data, pending, error } = useFetch('/api/products')
```

## Local override

```ts
useFetch('/api/admin', {
  headers: {
    authorization: `Bearer ${adminToken}`,
  },
})
```

## Logout

```ts
setContext({
  headers: {},
})
```

## New request after logout

```ts
useFetch('/api/profile')
```

No authorization header from the old context.

# Acceptance Criteria

The task is complete only when all of the following are true:

1. `setContext()` is publicly importable from `vue-ssr-lite`.

2. No `defineServer.fetch` or `defineApplication.fetch` configuration is added.

3. No `clearContext()` API is added.

4. `setContext()` accepts a context containing native `HeadersInit`.

5. Calling `setContext()` replaces the entire previous stored context.

6. `setContext({ headers: {} })` removes previously stored global headers.

7. Context state belongs to the active application/runtime and is never a process-global SSR singleton.

8. Concurrent SSR requests cannot observe each other's context.

9. The API works from real browser login/logout flows after initial component setup.

10. The API works during the application's `main.ts` initialization.

11. Calling it without an active application produces a descriptive error.

12. Context is copied/snapshotted at `setContext()` time.

13. Future `useFetch()` executions use the latest context.

14. Already in-flight requests retain the context snapshot with which they started.

15. `setContext()` alone does not refetch mounted hooks.

16. `refresh()` uses the latest context.

17. Reactive request re-execution uses the latest context.

18. Request-local `useFetch()` headers override global context defaults.

19. Existing same-origin SSR credential forwarding continues to work.

20. Context defaults are applied only to same-origin `useFetch()` requests.

21. Cross-origin requests do not automatically receive global context headers.

22. Context affects private cache/deduplication identity before request sharing occurs.

23. Different Authorization contexts cannot incorrectly share private authenticated responses.

24. Raw context secrets are not exposed through public hydration identity or serialized hydration state.

25. Native `fetch()` remains untouched.

26. `useFetch()` remains GET/HEAD only.

27. Root README documents login, replacement, logout, override, same-origin, refresh, and native-fetch boundaries.

28. `examples/4-server-api-app` demonstrates `setContext()` and removes repeated member headers from its `useFetch()` calls.

29. Native mutation requests in the example remain explicit about their own authentication because `setContext()` does not intercept native fetch.

30. Public type/export/package artifact coverage includes the new API.

31. No unrelated Server Routes, Server Middleware, SEO, routing, hydration, or application architecture is redesigned.

# Implementation Instruction

Focus strictly on writing/generating the implementation code, tests, types, documentation, and example changes.

DO NOT run:

```text
tests
build
typecheck
lint
Prettier
formatters
package validation
dev server
production server
Git commands
smoke tests
or any other validation command
```

The repository owner will run all validation after implementation is complete to conserve usage.

Do not stop after implementing only the easy public function. Trace the complete lifecycle from:

```text
setContext()
    ↓
runtime ownership
    ↓
context snapshot
    ↓
useFetch identity resolution
    ↓
header precedence
    ↓
cache/dedupe identity
    ↓
SSR isolation
    ↓
physical request
```

and implement the feature as one coherent request-safe capability.

Do not make assumptions where existing runtime infrastructure already solves a problem; inspect and reuse the current architecture first.
