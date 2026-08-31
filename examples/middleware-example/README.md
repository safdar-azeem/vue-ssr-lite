# vue-ssr-lite Middleware Example

This example demonstrates the `vue-ssr-lite` middleware API with a deliberately small mental model.

There are only two places where application developers declare middleware:

1. `server.ts` for middleware that runs on every route.
2. `route.meta.middleware` for middleware that belongs to a specific route.

Middleware can be synchronous or asynchronous, and the same middleware behavior is used during SSR and browser navigation. The demo auth middleware deliberately waits two seconds so the automatic route fallback and global loading bar are easy to see.

## Navigation loading

`App.vue` demonstrates both loading APIs without application-owned pending state:

```vue
<script setup lang="ts">
import { LoadingIndicator, RouteSuspense } from 'vue-ssr-lite'
</script>

<template>
  <LoadingIndicator />

  <div class="layout">
    <aside>Persistent sidebar</aside>

    <section>
      <header>Persistent header</header>

      <RouteSuspense>
        <RouterView />

        <template #fallback>
          <div class="page-skeleton">Loading page…</div>
        </template>
      </RouteSuspense>
    </section>
  </div>
</template>
```

Open Dashboard to see the header and sidebar remain mounted while only the route body shows its fallback. The fallback covers navigation middleware, guards, route resolution, and the Vue DOM update that commits the accepted route. Native Vue `<Suspense>` remains responsible for arbitrary async component setup. `LoadingIndicator` simultaneously shows the optional thin global bar. Fast navigations finish before the default visual delay and do not flash either loader.

The static loader in `index.html` is for the initial SPA boot, before Vue can mount safely. `RouteSuspense` and `LoadingIndicator` own later Vue Router navigations. SSR requests still wait for middleware before rendering the final route and do not render browser loading fallback UI.

## Global middleware

Register application-wide middleware once in `server.ts`:

```ts
import { defineServer } from 'vue-ssr-lite'
import { loggerMiddleware } from './src/middleware/loggerMiddleware'

export default defineServer({
  render: 'ssr',
  middleware: [loggerMiddleware],
})
```

`loggerMiddleware` now runs automatically for `/`, `/about`, `/dashboard`, `/dashboard/nested`, and `/login`.

It does not need to be repeated in every route.

## Route middleware

Add middleware directly to the route that needs it:

```ts
import { authMiddleware } from './middleware/authMiddleware'

{
  path: '/dashboard',
  component: DashboardPage,
  meta: {
    middleware: [authMiddleware],
  },
}
```

Middleware declared on a parent route also applies to its matched children. Therefore `/dashboard/nested` is protected by the middleware declared on `/dashboard`.

## `defineMiddleware()`

Middleware is normal application code and may be async:

```ts
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })

export const authMiddleware = defineMiddleware(async (context) => {
  await sleep(2000, context.signal)

  const session = context.cookies.get('single_session')

  if (!session) {
    return {
      path: '/login',
      query: { redirect: context.to.fullPath },
    }
  }

  return {
    props: {
      userName: 'john',
      role: 'admin',
    },
  }
})
```

A conceptual middleware context is:

```ts
interface MiddlewareContext {
  app: App
  router: Router

  cookies: {
    get(name: string): string | undefined
    set(name: string, value: string, options?: CookieOptions): void
    remove(name: string, options?: CookieOptions): void
  }

  to: RouteLocationNormalized
  from: RouteLocationNormalized | null

  server: boolean

  domain: DomainContext
  origin: string
  publicConfig: unknown

  signal: AbortSignal

  redirect(
    location: string | RouteLocationRaw,
    options?: {
      external?: boolean
      status?: 301 | 302 | 303 | 307 | 308
    },
  ): MiddlewareResult
}
```

## Return contract

`defineMiddleware()` keeps the existing `defineMiddleware(async (context) => {})` shape and uses Vue Router-style navigation return values wherever possible:

```ts
// Continue normally
return
return true

// Simple internal redirect
return '/login'

// Vue Router-style redirect
return {
  path: '/login',
  query: { redirect: context.to.fullPath },
}

// Data for the route record that declared the middleware
return {
  props: {
    userName: 'john',
    role: 'admin',
  },
}
```

Middleware may return these values directly or from an async function.

Final behavior is intentionally simple:

- `return` / `undefined` / `true` → continue navigation.
- `false` → cancel navigation.
- `'/login'` → redirect using a route string.
- `{ path, name, params, query, hash, ... }` → redirect using a normal Vue Router route location object.
- `{ props: { ... } }` → continue and provide props to the route record that declared that middleware.

Normal internal redirects do **not** require a `{ redirect: ... }` wrapper. This keeps the redirect behavior familiar to developers who already know Vue Router.

## Props behavior

`props` stay scoped to the route record that declared the middleware.

For `/dashboard/nested`:

- `authMiddleware` is declared by `/dashboard`.
- The middleware still runs for the nested route.
- Its returned props belong to `DashboardPage.vue`.
- They are not automatically injected into `DashboardNestedPage.vue`.

This keeps nested-route inheritance predictable without changing the meaning of route ownership.

## Execution order

For `/dashboard/nested`:

```text
request or browser navigation
  ↓
global middleware
  ↓
loggerMiddleware
  ↓
matched parent route middleware
  ↓
authMiddleware
  ↓
matched child route middleware, if any
  ↓
redirect OR continue
  ↓
render / confirm navigation
```

Core collects matched route middleware parent-to-child and avoids executing the same middleware function more than once for one logical navigation.

During SSR, middleware executes once for the logical request even if Core performs internal render reconciliation passes.

## SSR redirects

A middleware redirect during SSR becomes an actual HTTP redirect response rather than merely changing the internal Vue Router location.

In the browser, the same middleware result becomes a normal Vue Router redirect.

This gives application code one middleware contract for both environments.

## SSR and SPA behavior

For an SSR-rendered route, route middleware can execute on the server before the protected page is rendered.

For a route intentionally configured for direct SPA rendering, the server returns the SPA shell first, so application route middleware begins when the browser application starts.

Middleware remains application/navigation middleware rather than generic HTTP server middleware.

Use middleware for navigation decisions and small prerequisites, not as the
default page-data layer. Page queries and larger data loads should normally stay
with the page. The framework still provides correct feedback whenever a real
navigation check is asynchronous.

## What Core owns

`vue-ssr-lite` owns only generic middleware mechanics:

- global middleware execution
- route middleware execution
- SSR and browser execution
- parent-to-child ordering
- duplicate prevention per logical navigation
- normalized cookies
- abort signal
- internal/external redirect translation
- route-scoped middleware props/data

It should not understand authentication, permissions, roles, Builto, Apollo, GraphQL, sessions, or application business policy.

## What the application owns

This example application owns:

- the `single_session` cookie name
- what counts as authenticated
- the `/login` destination
- the user/role data returned by auth middleware
- which routes require `authMiddleware`

A real application can replace the fake cookie check with its own authentication runtime while keeping exactly the same middleware execution model.

## Important

Global middleware used from `server.ts` is universal code, so it and its dependencies must remain browser-safe. Route middleware already belongs to the route module's universal graph.
