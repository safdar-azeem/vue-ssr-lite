# task-005 — First-Party SSR-Aware `useFetch`

## Objective

Implement a minimal, first-party, fully type-safe SSR-aware `useFetch()` directly in `vue-ssr-lite`.

The architecture below is already decided.

**Do not research or compare other libraries. Do not redesign the API. The coding agent's responsibility is implementation only.**

The key requirement is that `await` is **optional**.

Both are valid:

```ts
const { data, pending, error, refresh } = useFetch<Product[]>('/api/products')
```

and:

```ts
const { data, pending, error, refresh } = await useFetch<Product[]>('/api/products')
```

They intentionally have different sequencing semantics while producing the same correct SSR HTML.

---

# 1. Core Optional-`await` Contract

`useFetch()` must return:

```ts
type UseFetchResult<TData> = UseFetchReturn<TData> & PromiseLike<UseFetchReturn<TData>>
```

This allows normal synchronous destructuring and optional `await`.

Internally use:

```text
non-thenable reactive base result
+
thenable public facade
```

Do **not** resolve the PromiseLike with the same thenable facade; that can recursively trigger Promise assimilation.

Conceptually:

```text
baseResult
├── data
├── pending
├── error
└── refresh()

publicResult
├── ...baseResult
└── then(...)
```

`then()` always resolves with the **non-thenable `baseResult`**.

---

# 2. Exact SSR Semantics

## A. Without `await`

```ts
const { data } = useFetch<Product[]>('/api/products')

// This executes immediately.
// data may still be undefined here.
doSomethingElse()
```

Lifecycle:

```text
setup()
 ↓
useFetch()
 ↓
create/join fetch
 ↓
register same execution with onServerPrefetch()
 ↓
return refs immediately
 ↓
remaining setup code executes
 ↓
Vue reaches SSR prefetch phase
 ↓
SSR WAITS for fetch
 ↓
data received
 ↓
refs/cache updated
 ↓
Vue renders final HTML with products
 ↓
serialize data for hydration
```

**Critical requirement:**

Not writing `await` must NEVER mean "client-only fetch".

The API request still executes during SSR and Vue must wait before producing final HTML.

Therefore:

```vue
<script setup>
const { data } = useFetch('/api/products')

// Executes before data necessarily exists.
console.log(data.value)
</script>

<template>
  <!-- Final SSR HTML still renders fetched products. -->
  <ProductList :products="data" />
</template>
```

The imperative line after `useFetch()` may observe pending data, but the final SSR-rendered template must observe the settled data.

---

## B. With `await`

```ts
const { data } = await useFetch<Product[]>('/api/products')

// On SSR, data is settled here.
useSeo({
  title: `${data.value?.length} Products`,
})
```

Lifecycle:

```text
setup()
 ↓
useFetch()
 ↓
native fetch starts / joins existing request
 ↓
await invokes PromiseLike.then()
 ↓
SSR WAITS
 ↓
data received
 ↓
cache + refs updated
 ↓
await resolves with base result
 ↓
remaining setup code executes
 ↓
Vue renders final HTML with products
 ↓
serialize data for hydration
```

This is the purpose of optional `await`:

> Developers use `await` only when later setup code itself depends on fetched data.

Do not create a second API for this.

---

# 3. Browser Semantics of Optional `await`

This is intentionally different from SSR.

## Without `await`

```ts
const { data, pending } = useFetch('/api/products')
```

Browser:

```text
setup
 ↓
useFetch
 ↓
start/join request
 ↓
return immediately
 ↓
pending=true
 ↓
component renders skeleton
 ↓
network finishes
 ↓
data updated
pending=false
```

## With `await`

```ts
const { data, pending } = await useFetch('/api/products')
```

Browser navigation:

```text
ProductsPage setup
 ↓
useFetch()
 ↓
browser request starts
 ↓
await invokes then()
 ↓
then() resolves base result immediately
(next microtask; DOES NOT await network)
 ↓
remaining setup executes
 ↓
page renders
 ↓
pending=true
 ↓
local skeleton
 ↓
network finishes
 ↓
pending=false
data=products
```

**Do not make browser `await useFetch()` wait for a newly started network request.**

A top-level `await` still makes Vue setup technically async, so Suspense may observe that microtask. That is acceptable.

It must **not remain suspended for the network duration**.

The enhanced `RouterView` must therefore not become the owner of useFetch network loading.

---

# 4. Hydration

SSR data must be serialized through the existing generic hydration system.

Reserve one internal contribution key such as:

```text
vue-ssr-lite:fetch
```

Flow:

```text
SERVER

useFetch
 ↓
network
 ↓
data
 ↓
SSR HTML
 ↓
hydration payload


BROWSER

restore fetch state BEFORE component setup
 ↓
useFetch(same identity)
 ↓
reuse SSR result
 ↓
pending=false
 ↓
NO network request
 ↓
NO callback replay
```

This hydration authority overrides `network-only`.

`network-only` must **not** cause:

```text
SSR fetch
+
hydration fetch
```

Hydration is continuation of the same initial render, not another logical execution.

With:

```ts
await useFetch(...)
```

during hydration, `await` resolves immediately because restored data already exists.

---

# 5. Public API

Keep v1 deliberately small.

```ts
export type UseFetchPolicy = 'network-only' | 'cache-first'

export type UseFetchVariablePrimitive = string | number | boolean | null | undefined

export type UseFetchVariableValue = UseFetchVariablePrimitive | readonly UseFetchVariablePrimitive[]

export type UseFetchVariables = Record<string, UseFetchVariableValue>

export interface UseFetchError {
  readonly name: 'UseFetchError'
  readonly kind: 'http' | 'network' | 'parse' | 'timeout'

  readonly message: string
  readonly status?: number
  readonly statusText?: string
}

export interface UseFetchReturn<TData> {
  data: ShallowRef<TData | undefined>
  pending: Readonly<ShallowRef<boolean>>
  error: Readonly<ShallowRef<UseFetchError | null>>
  refresh: () => Promise<void>
}

export type UseFetchResult<TData> = UseFetchReturn<TData> & PromiseLike<UseFetchReturn<TData>>
```

Options:

```ts
key?: string

method?: 'GET' | 'HEAD'

variables?: MaybeRefOrGetter<TVariables>

fetchPolicy?: UseFetchPolicy
nextFetchPolicy?: UseFetchPolicy

server?: boolean
immediate?: boolean
timeout?: number
signal?: AbortSignal

onDone?: (
  ctx: UseFetchDoneContext<TData, TVariables>
) => void

onError?: (
  ctx: UseFetchErrorContext<TVariables>
) => void
```

Signature concept:

```ts
export function useFetch<TData = unknown, TVariables extends UseFetchVariables = UseFetchVariables>(
  url: MaybeRefOrGetter<string | URL>,
  options?: UseFetchOptions<TData, TVariables>
): UseFetchResult<TData>
```

Defaults:

```text
method           GET
server           true
immediate        true
fetchPolicy      network-only
nextFetchPolicy  same as fetchPolicy
timeout          disabled
```

Do not add `staleTime`.

---

# 6. Type Safety

Required:

```ts
interface Product {
  id: number
  name: string
  price: number
}

const { data } = useFetch<Product[]>('/api/products')
```

`data` must be:

```ts
ShallowRef<Product[] | undefined>
```

The same typing must survive `await`:

```ts
const { data } = await useFetch<Product[]>('/api/products')
```

Still:

```ts
ShallowRef<Product[] | undefined>
```

Typed variables:

```ts
interface ProductVariables {
  category: string
  page?: number
}

useFetch<Product[], ProductVariables>('/api/products', {
  variables: {
    category: 'books',
    page: 2,
  },

  onDone(ctx) {
    ctx.data
    // Product[]

    ctx.variables
    // Readonly<ProductVariables>
  },
})
```

If `TVariables` contains required properties, TypeScript must require `variables`.

Incorrect variable names/types must fail at compile time.

The generic is compile-time typing only. Do not claim runtime schema validation.

---

# 7. Variables

For this REST abstraction, `variables` means URL query/search variables.

```ts
useFetch('/api/products', {
  variables: {
    category: 'books',
    page: 2,
    active: true,
  },
})
```

Canonical URL:

```text
/api/products?active=true&category=books&page=2
```

Rules:

```text
undefined → omit
null      → key=
primitive → String(value)
array     → repeated key
```

Variable keys are sorted canonically.

Array ordering is preserved.

Variables replace an existing URL query parameter with the same key.

No nested objects in v1.

Both URL and variables may be reactive refs/getters.

---

# 8. Fetch Policies

Only:

```text
network-only
cache-first
```

### `network-only`

Ignore settled useFetch cache, execute native fetch, then update cache.

Still deduplicate the same in-flight request.

### `cache-first`

```text
successful cached result
→ use it

otherwise
→ network
```

Cached errors do not satisfy `cache-first`.

### `nextFetchPolicy`

For one mounted hook:

```text
first automatic execution
→ fetchPolicy

later automatic executions
→ nextFetchPolicy ?? fetchPolicy
```

Example:

```ts
useFetch('/api/products', {
  variables,
  fetchPolicy: 'network-only',
  nextFetchPolicy: 'cache-first',
})
```

means:

```text
first          network-only
later          cache-first
```

Hydrated SSR data means the initial execution is already complete.

Later browser executions use `nextFetchPolicy`.

A newly mounted hook starts again from `fetchPolicy`.

---

# 9. `refresh()`

`refresh()` always means:

```text
explicit fresh network execution
```

Regardless of current policy.

```ts
await refresh()
```

must genuinely wait for that refresh in **both server and browser environments**, unlike `await useFetch()` browser initialization.

Rules:

- force network;
- keep previous data;
- `pending=true`;
- clear previous error;
- deduplicate identical active refresh;
- update shared cache;
- `pending=false` after settlement.

Do not change first/next policy progression.

---

# 10. `immediate:false` and `server:false`

These must not create await deadlocks.

### `immediate:false`

```ts
const result = useFetch('/api/products', {
  immediate: false,
})
```

No automatic execution.

Therefore:

```ts
await useFetch('/api/products', {
  immediate: false,
})
```

must resolve immediately with the idle base result.

`await` must NOT implicitly execute the request.

Only `refresh()` starts it.

### `server:false`

On SSR:

```text
no server network request
```

`await useFetch(..., { server:false })` resolves immediately.

The browser starts the request after hydration is safe.

Do not create a server-side unresolved Promise.

---

# 11. SSR Reconciliation

The renderer may recreate applications across resolution passes.

A request already performed during the same HTTP request must never run again because setup was recreated.

```text
pass 1
 ↓
fetch products
 ↓
save request-local fetch state
 ↓
reconciliation
 ↓
pass 2
 ↓
restore same fetch state
 ↓
ZERO second API request
```

This rule overrides `network-only`.

Distinguish:

```text
new HTTP request          → network-only may fetch
same HTTP reconciliation → NEVER repeat settled fetch
browser hydration         → NEVER repeat SSR fetch
```

Reuse existing hydration/resume-state architecture.

Do not invent another SSR resolution mechanism.

---

# 12. Callbacks

Support:

```ts
onDone(ctx) {}
onError(ctx) {}
```

These are **network-execution callbacks**, not generic cache-change callbacks.

`onDone` runs after a successful logical network execution.

`onError` runs for:

- HTTP error
- network error
- parse error
- timeout

Do not fire them for:

- hydration restoration;
- `cache-first` cache hit;
- SSR reconciliation restoration;
- passive cache updates;
- lifecycle cancellation;
- obsolete/stale execution.

Callbacks capture the variables snapshot from execution start.

```ts
ctx.data
ctx.variables
ctx.key
ctx.server
ctx.response
```

If two hooks join one physical request:

```text
1 physical request
2 requesting hook executions
```

each requesting hook receives its own callback once.

Do not replay server callbacks during hydration.

Callback exceptions must not turn a successful query into a failed query.

For awaited SSR execution:

```text
fetch settles
 ↓
state/cache updated
 ↓
onDone/onError
 ↓
await useFetch resolves
```

---

# 13. Error / Await Behavior

Expected API/network failures populate:

```ts
error.value
```

They do not normally reject `await useFetch()`.

Example:

```ts
const { data, error } = await useFetch<Product[]>('/api/products')

// SSR execution has settled here.
// Could be success OR handled fetch error.
```

Therefore code that requires successful data must check:

```ts
if (!error.value && data.value) {
  // use data
}
```

Programming/configuration errors may throw/reject.

`refresh()` similarly resolves after handled network failure with `error` updated; it does not require try/catch for ordinary HTTP failures.

---

# 14. Cache Ownership

Server:

```text
HTTP request A → cache A
HTTP request B → cache B
```

Never global.

Never share authenticated/user/tenant data between requests.

Browser:

```text
one mounted vue-ssr-lite application
→ one fetch cache
```

Same-key consumers share:

- settled data;
- in-flight network request;
- errors while active;
- cache updates.

Each hook still owns:

- callback subscription;
- reactive identity;
- fetchPolicy progression.

Keep successful orphaned browser entries in a small internal LRU:

```text
maximum 100 orphaned successful entries
```

Active/pending entries cannot be evicted.

Remove orphaned errors.

Clear everything on application unmount.

No public cache-size configuration.

---

# 15. Request Identity

Generate deterministic identity from:

```text
method
normalized URL
canonical variables
safe request semantics
explicit custom key namespace
```

Same-origin SSR/browser identities must match.

Do not serialize secrets into hydration state.

Never put raw:

```text
Cookie
Authorization
credentials
```

into public cache keys.

Maintain a separate non-serialized fingerprint for sensitive/request-specific options.

Detect incompatible calls sharing the same public identity rather than silently returning incorrect cached data.

---

# 16. SSR Relative URLs & Credentials

Browser:

```ts
useFetch('/api/products')
```

uses native relative fetch semantics.

Server:

resolve relative URLs against the actual incoming HTTP request origin.

Do not use canonical SEO `siteOrigin`.

For same-origin SSR fetches:

- forward incoming Cookie unless `credentials:'omit'`;
- forward Authorization when appropriate;
- explicit consumer Authorization wins;
- never blindly proxy hop-by-hop/proxy headers.

For external absolute URLs:

```ts
useFetch('https://external.example/data')
```

never automatically leak incoming Cookie or Authorization.

Do not proxy downstream `Set-Cookie` into the page response in v1.

---

# 17. Response Parsing

```text
HEAD                → undefined
204 / 205           → undefined
application/json    → JSON
application/*+json  → JSON
other 2xx           → text
```

Errors:

```text
HTTP failure   → kind:'http'
network        → kind:'network'
JSON parse     → kind:'parse'
timeout        → kind:'timeout'
```

Lifecycle cancellation is not a user-facing fetch error.

Do not hydrate raw Response objects, headers, stacks, cookies, tokens, streams, Blob, FormData, etc.

---

# 18. Reactive Identity & Races

Support:

```ts
const id = ref(1)

const result = useFetch(() => `/api/products/${id.value}`)
```

and reactive variables.

On identity change:

```text
detach old identity
 ↓
abort old request only if orphaned
 ↓
derive new identity
 ↓
apply nextFetchPolicy
 ↓
cache or network
```

Never allow an older response to overwrite newer state.

Use an execution generation/token.

When moving to another identity, do not display old-key data as though it belongs to the new key.

During `refresh()` of the same identity, retain old data.

---

# 19. Cancellation

Compose:

```text
SSR request AbortSignal
explicit caller signal
entry AbortController
timeout
application lifecycle
```

Guarantees:

- aborted SSR request aborts downstream fetch;
- app unmount aborts active requests;
- shared request remains alive while another consumer needs it;
- orphaned request aborts;
- stale result cannot win;
- timeout creates timeout error;
- lifecycle cancellation does not trigger `onError`.

---

# 20. Implementation Ownership

Add approximately:

```text
src/data/
├── SsrFetchTypes.ts
├── SsrFetchRuntime.ts
├── useFetch.ts
├── index.ts
├── SsrFetchRuntime.test.ts
└── useFetch.test.ts
```

Integrate with:

```text
src/SsrApplicationRuntime.ts
src/SsrHydrationRuntime.ts
src/index.ts

src/SsrPublicApi.test.ts
src/SsrReleaseContract.test.ts

scripts/SsrPackageArtifact.mjs

README.md
examples/1-single-app/src/pages/ProductsPage.vue
```

Create/provide the fetch runtime before root component setup.

Reuse the existing hydration controller.

Do not implement through the public extension API.

No module-global `Map`, singleton, or request state.

---

# 21. Critical Validation Matrix

The implementation must cover both optional-await modes.

### SSR without await

```ts
const { data } = useFetch<Product[]>('/api/products')

marker = data.value
```

Assert:

```text
marker may initially observe undefined
BUT
final SSR HTML contains products
AND
only one HTTP request occurred
```

### SSR with await

```ts
const { data } = await useFetch<Product[]>('/api/products')

marker = data.value
```

Assert:

```text
marker observes products
final SSR HTML contains products
one HTTP request
```

### Browser without await

Assert:

```text
setup synchronous
pending=true
local skeleton
network later resolves
```

### Browser with await

Assert:

```text
await resolves without waiting for network
pending=true
component mounts
local skeleton
network later resolves
```

### Hydration with and without await

Assert:

```text
SSR data restored
pending=false
zero browser network requests
same HTML/data
```

Also cover:

1. SSR reconciliation never duplicates fetch.
2. typed return with and without await.
3. typed required variables.
4. network-only/cache-first/nextFetchPolicy.
5. explicit refresh.
6. same-key in-flight dedupe.
7. callback ownership.
8. reactive URL/variables race protection.
9. request cancellation.
10. same-origin credential forwarding.
11. cross-origin credential isolation.
12. parser behavior.
13. concurrent SSR tenant isolation.
14. browser application/cache isolation.
15. LRU bounds.

---

# 22. Final Developer Experience

## Normal page

No sequential setup dependency:

```vue
<script setup lang="ts">
import { useFetch } from 'vue-ssr-lite'

const { data: products, pending, error, refresh } = useFetch<Product[]>('/api/products')
</script>
```

Direct SSR still renders products.

Client navigation gets local `pending` UI.

---

## SSR-dependent setup logic

When later setup code requires data:

```vue
<script setup lang="ts">
import { useFetch, useSeo } from 'vue-ssr-lite'

const { data, error } = await useFetch<Product[]>('/api/products')

if (!error.value) {
  useSeo({
    title: `${data.value?.length ?? 0} Products`,
  })
}
</script>
```

On SSR:

```text
fetch
→ wait
→ data
→ subsequent setup
→ SEO
→ HTML
```

On client navigation:

```text
fetch starts
→ await resolves without network wait
→ data initially undefined
→ pending UI
→ reactive data later
```

Therefore, code after `await useFetch()` is guaranteed to have settled data **only during SSR/hydration**, not during a new browser-side network request.

This distinction must be clearly documented.

If later client-side code must wait for the network, use:

```ts
await refresh()
```

or react to `pending/data`; do not change `await useFetch()` browser semantics.

---

# Non-goals

Do not add:

- POST/PUT/PATCH/DELETE orchestration
- mutation API
- `useAsyncData`
- polling
- retry
- cache-and-network
- cache-only
- no-cache
- staleTime
- normalized entity cache
- optimistic updates
- pagination
- persistent server cache
- Redis
- cache tags
- interceptors
- transforms
- public QueryClient
- internal API short-circuiting

Native `fetch`, GraphQL/Apollo, Axios, TanStack Query, etc. remain valid alternatives.

The goal is:

> **native fetch + Vue refs + optional SSR-aware await + request-safe caching + hydration + deduplication**

---

# Implementation Discipline

Everything required for architecture/API behavior is defined above.

**Do not research competing libraries. Do not redesign the API. Do not introduce additional features.**

Focus only on writing/modifying:

- source code;
- TypeScript types;
- tests;
- example;
- documentation.

**Do not run tests, builds, TypeScript validation, package smoke, dev server, benchmarks, codegen, or Git commands. Safdar will perform validation after implementation.**
