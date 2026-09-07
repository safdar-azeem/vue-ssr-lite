# vue-ssr-lite

A lightweight SSR runtime for **Vue 3**.

Add server rendering, hydration, middleware, SEO, hybrid routes, multi-app hosting, caching, and production server features to your existing Vue application — without adopting a full framework or changing your architecture.

Small, fast, and simple.

## Features

- Hybrid SSR/SPA routes
- Multiple SSR and SPA applications on one port
- Domain, subdomain, and custom-domain routing
- Global middleware and route-level middleware
- Built-in SEO and head management
- `/sitemap.xml` and `/robots.txt`
- Request-aware route CSS and module preloads
- Canonical URLs, Open Graph, Twitter Cards, and JSON-LD
- First-party SSR-aware `useFetch()` with optional await, hydration, reactive state, and request-safe caching

# Installation

```bash
npm install vue-ssr-lite vue-router
# or
yarn add vue-ssr-lite vue-router
# or
pnpm add vue-ssr-lite vue-router
```

## Example Applications

See [`examples/`](./examples) for small, practical examples showing recommended `vue-ssr-lite` patterns and architecture.

- [`single-app`](./examples/1-single-app/) — minimal single-application SSR
- [`hybrid-route-app`](./examples/2-hybrid-route-app/) — route-level SSR and SPA rendering
- [`multi-domain-apps`](./examples/3-multi-domain-apps/) — multiple applications and host routing
- [`server-api-app`](./examples/4-server-api-app/) — complete Server Routes, Server Middleware, and `useFetch()` example
- [`middleware-example`](./examples/middleware-example/) — Vue navigation middleware

# Minimal Setup

## 1. Add the Vite plugin

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vueSsrLite } from 'vue-ssr-lite/vite'

export default defineConfig({
  plugins: [vueSsrLite(), vue()],
})
```

## 2. Add scripts

```json
{
  "scripts": {
    "dev": "vue-ssr-lite dev",
    "build": "vue-ssr-lite build",
    "start": "vue-ssr-lite start"
  }
}
```

## 3. Configure the server

```ts
// server.ts
import { defineServer } from 'vue-ssr-lite'

export default defineServer({
  render: 'ssr',
  server: {
    port: 4211,
  },
})
```

## 4. Use your existing Vue application

```text
/
├── server.ts
└── src/
    ├── main.ts
    ├── App.vue
    ├── routes.ts
    ├── style.css
    ├── middleware/
    │   └── authMiddleware.ts
    └── pages/
```

```ts
// src/routes.ts
import type { RouteRecordRaw } from 'vue-router'
import { authMiddleware } from './middleware/authMiddleware'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: PublicHomePage,
    meta: {
      seo: {
        title: 'Home',
        description: 'Public home page rendered with SSR.',
      },
    },
  },
  {
    path: '/dashboard',
    component: DashboardPage,
    meta: {
      render: 'spa', // this route and its children are SPA only
      middleware: [authMiddleware],
      seo: {
        title: 'Dashboard',
        description: 'Private dashboard rendered as a client-side SPA.',
      },
    },
    children: [
      {
        path: 'nested',
        component: DashboardNestedPage,
      },
    ],
  },
]

export default routes
```

```ts
// src/middleware/authMiddleware.ts
import { defineMiddleware } from 'vue-ssr-lite'

export const authMiddleware = defineMiddleware(async (context) => {
  const token = context.cookies.get('auth-token')
  if (!token) return context.redirect('/login')
  const user = await fetchUserFromToken(token)
  if (!user) return context.redirect('/login')
  return { props: { user } }
})
```

Update your standard Vue `main.ts`:

```ts
// src/main.ts
import { createPinia } from 'pinia'
import type { AppContext } from 'vue-ssr-lite'
import routes from './routes'
import './style.css'

export { routes }

export default ({ app }: AppContext) => {
  app.use(createPinia())
}
```

```vue
<!-- src/App.vue -->
<script setup lang="ts">
import { RouterView } from 'vue-ssr-lite'
</script>

<template>
  <RouterView />
</template>
```

## 5. HTML entry

Keep a standard Vite `index.html` at the project root.

## 6. Start development

```bash
npm run dev
```

> Your Vue application is now SSR. You are ready to go. If you need extra configuration or other features, continue below.

# Part 2: Make the small application useful

## Data Fetching Basics

Once your application is running, `useFetch()` is the built-in way to load page data without leaving the Vue SSR flow.

```vue
<script setup lang="ts">
import { useFetch } from 'vue-ssr-lite'

interface Product {
  id: number
  title: string
}

interface ProductsResponse {
  products: Product[]
}

const { data, pending, error, refresh } = useFetch<ProductsResponse>('/api/products')
</script>

<template>
  <p v-if="pending">Loading products…</p>
  <p v-else-if="error">Unable to load products.</p>

  <template v-else>
    <article v-for="product in data?.products" :key="product.id">
      <h2>{{ product.title }}</h2>
    </article>
  </template>

  <button :disabled="pending" @click="refresh()">Refresh</button>
</template>
```

- Direct SSR requests include the fetched result in the rendered HTML.
- Hydration restores the server result without repeating the first request.
- Browser navigation shows `pending` while the request is running.
- `refresh()` fetches fresh data on demand.

## Variables

Use `variables` for query params. They can be reactive:

```ts
useFetch('/api/products', {
  variables: () => ({
    category: category.value,
    page: page.value,
  }),
})
```

## Global Request Context

Use `setContext()` for application-wide defaults such as auth headers:

```ts
import { setContext } from 'vue-ssr-lite'

setContext({
  headers: {
    authorization: `Bearer ${token}`,
  },
})

const profile = useFetch('/api/profile')
```

- Each `setContext()` call replaces the previous context.
- Clear defaults with `setContext({ headers: {} })`.
- Request-local headers override the stored context.
- Context applies only to same-origin `useFetch()` requests.
- Native `fetch()` and other clients are unaffected.
- For a one-off request, `context:false` skips stored defaults only.

For advanced useFetch behavior including await semantics, caching policies, manual/client-only execution, cancellation, request options, callbacks, context opt-out, and detailed request behavior, see [Advanced useFetch](#advanced-usefetch).

# Application Shell

These are **optional overrides only**. Default locations (`/src/main.ts` and `/src/App.vue`) are already used automatically. Configure these only when your files have different names or paths.

```ts
defineServer({
  app: {
    main: './src/custom-main.ts',
    root: './src/CustomApp.vue',
  },
})
```

# Hybrid Route Rendering

One application can mix SSR and SPA on the same domain:

```ts
export default defineServer({
  render: 'ssr',
})
```

Set `meta.render` on a route in `src/routes.ts`:

```ts
// src/routes.ts
{
  path: '/app',
  component: WorkspaceLayout,
  meta: {
    render: 'spa' // 'ssr'
  },
  children: [
    { path: '' },
    { path: 'projects' },
    { path: 'settings' },
  ],
}
```

All nested children of that route stay SPA.

# Multiple Applications

Use this when one Vue application is not enough — for example a landing website, an app, an admin panel, and docs, each on its own host:

```text
SSR  domain.com         landing website
SPA  app.domain.com     app
SPA  admin.domain.com   admin panel
SSR  docs.domain.com    docs
```

Hybrid routing stays on one domain in one application. Multiple applications are separate apps. Each can have its own routes, render mode, SEO, and host. They still run in one Node process on one port.

Register each application in `server.ts`. They are not discovered automatically.

```ts
// server.ts
import { defineServer } from 'vue-ssr-lite'
import website from './src/modules/website/app'
import app from './src/modules/app/app'
import admin from './src/modules/admin/app'
import docs from './src/modules/docs/app'
export default defineServer({
  server: { port: 4211 },
  applications: [website, app, admin, docs],
})
```

```ts
// src/modules/website/app.ts
import { defineApplication } from 'vue-ssr-lite'
import routes from './routes'
export default defineApplication({
  name: 'website',
  render: 'ssr',
  domain: {
    development: 'localhost',
    production: 'domain.com',
  },
  routes,
})
```

```ts
// src/modules/app/app.ts
import { defineApplication } from 'vue-ssr-lite'
import routes from './routes'
export default defineApplication({
  name: 'app',
  render: 'spa',
  domain: {
    development: 'app.localhost',
    production: 'app.domain.com',
  },
  routes,
})
```

```ts
// src/modules/admin/app.ts
import { defineApplication } from 'vue-ssr-lite'
import routes from './routes'
export default defineApplication({
  name: 'admin',
  render: 'spa',
  domain: {
    development: 'admin.localhost',
    production: 'admin.domain.com',
  },
  routes,
})
```

By default every application uses the global `/src/main.ts` and `/src/App.vue`. An application can override that shell; paths inside `app.ts` resolve relative to that module:

```ts
// src/modules/docs/app.ts
import { defineApplication } from 'vue-ssr-lite'
import routes from './routes'
export default defineApplication({
  name: 'docs',
  render: 'ssr',
  domain: {
    development: 'docs.localhost',
    production: 'docs.domain.com',
  },
  routes,
  app: {
    main: './main.ts',
    root: './App.vue',
  },
})
```

Application identity is `name`, never array index. Duplicate names are rejected. Applications never declare a port; one Node process serves every application on the managed server port. `PORT` may still override that single port.

## Host and domain routing

Use `host` when an application only needs fixed host matching:

```ts
defineApplication({
  name: 'admin',
  host: ['admin.example.com', 'admin.internal.example.com'],
  routes,
})
```

Use `domain` when routing varies by environment or needs subdomains, local aliases, custom domains, additional hosts, or domain params:

```ts
defineApplication({
  name: 'storefront',
  domain: {
    development: 'shop.localhost',
    production: 'shop.example.com',
    mode: 'root-and-subdomains',
    customDomains: true,
    params: {
      storeDomain: { source: 'subdomain-or-hostname' },
    },
  },
  routes,
})
```

`host` and `domain` are alternatives and cannot be used together on the same application. Exact hosts outrank wildcard/subdomain matches, which outrank the explicit `customDomains: true` catch-all. With no matching owner and no custom domain catch-all, Core returns `421 Misdirected Request` with `No application serves this host.`

`customDomains: true` means that the application may receive unmatched/custom hosts. The application can then resolve the hostname against its own API or database; Core does not impose a business-specific custom-domain verification callback.

# Vue Plugins

Install stateful plugins inside `main.ts` so each Vue application/request gets a fresh instance:

```ts
export default ({ app }: AppContext) => {
  app.use(createPinia())
}
```

# Middleware

Use `defineMiddleware()` for small universal navigation checks and route data:

```ts
import { defineMiddleware } from 'vue-ssr-lite'
export const requestMiddleware = defineMiddleware(async (context) => {
  const variant = context.cookies.get('variant')
  return variant ? { props: { variant } } : true
})
```

Application-wide middleware is declared once in `server.ts` for a single app, or on the relevant `defineApplication()` in multi-app mode:

```ts
export default defineServer({
  middleware: [loggerMiddleware],
})
```

Route middleware uses direct function references:

```ts
{
  path: '/dashboard',
  component: DashboardPage,
  meta: { middleware: [requestMiddleware] },
}
```

Global middleware runs on every navigation. Route middleware runs for route records entered by the navigation, parent to child. A parent route's middleware protects entry into that route branch, but it does not rerun when navigating between descendants while the parent remains active. Leaving and later re-entering the branch runs it again.

```text
/about → /dashboard
requestMiddleware runs
/dashboard → /dashboard/nested
requestMiddleware does not rerun
/dashboard/nested → /about → /dashboard/nested
requestMiddleware runs again
```

The same function runs once per target navigation. Middleware may be synchronous or async. Return nothing or `true` to continue, `false` to cancel, a normal Vue Router location to redirect, or `{ props }` to add props to the default component of the route that declared that middleware. Existing route props are composed, with later middleware values winning. Accepted parent middleware props remain owned by the parent component while that route record stays active.

On a direct SSR request, a middleware redirect becomes a real HTTP redirect and the rejected component tree is not rendered. A direct SPA request still receives the SPA shell first; middleware starts with the browser application navigation.

Use `context.redirect()` only for an explicit redirect status or intentional external full-document navigation.

Middleware receives the current app/router, target and previous route, normalized cookies, domain, authoritative origin, public config, environment flag, and an abort signal. Middleware that may run during SSR is statically projected into the browser definition, so its complete dependency graph must remain universal and browser-safe.

When Core can statically prove that an application declares `render: 'spa'`, its middleware can only execute in the browser (SPA route branches cannot opt back into SSR). Core still projects the exact middleware binding and protects the configuration from mutation, but leaves that middleware's ordinary browser dependency graph to Vite. No separate client-middleware API is needed.

Middleware should primarily handle navigation decisions such as authentication, authorization, workspace resolution, redirects, and small route prerequisites.

Normal page data usually belongs in the page's query or data layer. When a valid navigation check is async, it automatically participates in navigation loading.

# Navigation Loading

Use the enhanced route outlet to give that part of the page a custom delayed fallback:

```vue
<script setup lang="ts">
import { RouterView } from 'vue-ssr-lite'
</script>
<template>
  <AppLayout>
    <Sidebar />
    <Header />
    <RouterView :delay="120">
      <template #fallback>
        <PageSkeleton />
      </template>
    </RouterView>
  </AppLayout>
</template>
```

`RouterView` delegates route matching and component reuse to Vue Router and async component readiness to native Vue `<Suspense>`. It follows async middleware, redirects, cancellation, other guards, lazy components, async `setup()`, and top-level `await` as one loading lifecycle. There is no manual pending state and the delay is not restarted when navigation hands off to an async page. Nested outlets select the closest enhanced view whose matched route record is changing.

Internally, router acceptance and page readiness are separate milestones. A successful router transaction stays loading until the selected outlet's current Suspense generation resolves. Cancellation and errors finish without waiting for rejected destination work, and a superseded page generation cannot finish the newer navigation's loader. Readiness is acknowledged by the destination generation after it is actually mounted or updated inside its Suspense branch;

it is not inferred from the absence of a `pending` event. Application wrappers such as out-in transitions may therefore delay mounting without ending the navigation clock early.

The fallback is the route area's normal rendered state while loading. The component adds no layout element or fallback CSS: a skeleton can be full-page, card-sized, centered, or any other shape entirely through application code.

While middleware or guards can still cancel, a fully resolved current page may be retained outside the document so cancellation can restore the same component instance. That retention ends at the router decision; unresolved destinations are never retained by it, and it does not become an implicit page cache.

The fallback is optional and entirely application-owned. Quick navigations that finish before the delay do not flash it.

The native scoped-slot shape is also available for application-owned `KeepAlive` or transition composition. `RouterView` does not add a route key, so Vue Router's normal component-reuse behavior remains intact:

```vue
<RouterView>
  <template #default="{ Component }">
    <KeepAlive>
      <component :is="Component" />
    </KeepAlive>
  </template>
  <template #fallback>
    <PageSkeleton />
  </template>
</RouterView>
```

The scoped `Component` includes the enhanced page Suspense boundary. An application-owned `KeepAlive` therefore remains outside page readiness and is the only mechanism that keeps accepted pages cached across later navigations.

For a simple global bar, use the optional CSS-animated indicator alone or together with a route fallback:

```vue
<script setup lang="ts">
import { LoadingIndicator, RouterView } from 'vue-ssr-lite'
</script>
<template>
  <LoadingIndicator :delay="120" />
  <RouterView />
</template>
```

`LoadingIndicator` forwards `class` and `style` to its root element, so the indicator can be sized or positioned alongside the rest of your application:

```vue
<LoadingIndicator class="app-loading" :style="{ height: '4px' }" />
```

The default color is `#3B82F6` in light mode and `#3B82F6` in dark mode. Dark mode is selected automatically when any parent or document element has the `dark` or `dark-mode` class. To override the color, set the existing `--vssl-loading-indicator-color` variable from application CSS:

```css
.app-loading {
  --vssl-loading-indicator-color: #000;
}
```

You can also set the variable globally. An explicit application value remains authoritative in both themes:

```css
:root {
  --vssl-loading-indicator-color: #000;
}
```

The inner bar uses inline width, height, transform, and animation values while navigation is loading. The supported styling surface is the root `class`/`style` plus the color variable above.

SSR renders the accepted route content directly and hydration does not show a loader for that already-rendered page. A direct SPA load happens before Vue is mounted, so keep a small static shell fallback in `index.html` for initial boot:

```html
<div id="app"></div>
<div class="initial-loader">Loading application…</div>
<style>
  #app:not(:empty) + .initial-loader {
    display: none;
  }
</style>
```

After mount, `RouterView` and `LoadingIndicator` use the same subsequent browser navigation clock. The indicator remains active after `afterEach` while the accepted destination still has unresolved lazy components, async `setup()`, or top-level `await` work.

Vue Router's default and application-defined `scrollBehavior` run after that accepted page generation is ready, so saved positions and hash targets can refer to async page content. If a later navigation supersedes the page while an asynchronous custom scroll behavior is still running, its eventual position is discarded instead of being applied to the newer page.

# SEO

SEO is composed from:

1. Server or application `seo.site`
2. Request-resolved site defaults when `site` is a server-only resolver
3. Matched route records, parent to child, with `meta.seo`
4. Active page/component layers with `useSeo()`

Later layers win for singleton fields. `null` clears an inherited string, nested object, or collection where the field type permits it.

## Global SEO

```ts
export default defineServer({
  seo: {
    site: {
      siteName: 'My Store',
      title: 'Home',
      titleTemplate: '%s | My Store',
      description: 'My online store.',
      image: 'https://example.com/social.png',
      index: true,
      follow: true,
    },
    siteUrl: 'https://example.com',
  },
})
```

For multi-application configuration, put `seo` on the relevant `defineApplication()` result.

## Request-resolved site SEO

```ts
// server.ts
import { defineServer, type SiteSeoResolution } from 'vue-ssr-lite'
export default defineServer({
  seo: {
    site: {
      resolve: async ({ applicationId, siteOrigin, domain, signal }): Promise<SiteSeoResolution> => {
        const response = await fetch(`https://api.example.com/sites/${domain.hostname}`, { signal })
        const site = await response.json()
        if (!site) return { status: 'not-found', responseStatus: 404 }
        return {
          status: 'resolved',
          defaults: {
            siteName: site.name,
            title: site.defaultTitle,
            description: site.description,
          },
          revision: site.seoRevision,
        }
      },
    },
  },
})
```

The resolver never runs in the browser. Core supplies `siteOrigin` from the selected application's normalized request domain.

## Route SEO

```ts
{
  path: '/about',
  component: AboutPage,
  meta: {
    seo: {
      title: 'About',
      description: 'About our company.',
    },
  },
}
```

## `useSeo()`

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { useSeo } from 'vue-ssr-lite'
useSeo(
  computed(() => ({
    title: article.value.title,
    description: article.value.description,
  }))
)
</script>
```

`useSeo()` accepts a plain object, `Ref`, computed ref, or getter. Active layers are scoped to their component. Reactive updates, KeepAlive, unmount, navigation, Back, and Forward all recalculate the effective head.

# Server Routes and Server Middleware

`defineServerRoutes()` declares application-owned HTTP routes. Handlers receive a
native Web `Request` and return a native `Response`; read query parameters with
`new URL(request.url).searchParams` and bodies with `request.json()` or `request.text()`.

```ts
import { defineServer, defineServerRoutes, defineServerMiddleware } from 'vue-ssr-lite'

const loggerMiddleware = defineServerMiddleware(async (request, context, next) => {
  const response = await next()
  console.log(context.requestId, request.method, response.status)
  response.headers.set('x-service', 'shop')
  return response
})

const authMiddleware = defineServerMiddleware<{ user: { id: string } }>(async (request, context, next) => {
  const user = await authenticate(request) // your normal server-side import
  if (!user) return new Response(null, { status: 401 })
  context.user = user
  return next()
})

const productsRoutes = defineServerRoutes({
  prefix: '/api/products',
  middleware: [authMiddleware], // group scope
  routes: {
    '/:id': {
      GET(request, context) {
        return Response.json({ id: context.params.id, userId: context.user.id })
      },
    },
  },
})

export default defineServer({
  serverMiddleware: [loggerMiddleware],
  serverRoutes: [productsRoutes],
})
```

Route middleware has three scopes: group `middleware`, path `middleware`, and
method `{ middleware, handler }`. They run in that order and unwind in reverse;
each middleware must return a `Response` or `return next()`, and call `next()` at
most once. A middleware can short-circuit with an error response or catch errors
from `await next()`. Use `new URL('/login', request.url)` for native redirects.
Core gives upstream middleware a Response with mutable headers, including when
downstream returns `Response.redirect()` or a response from `fetch()`. It preserves
the status, status text, cookies and original body stream without buffering or
teeing. Consumed/locked bodies and non-HTTP responses such as `Response.error()`
(status 0) fail through the normal framework error handler.

Returning a Node `fetch()` response streams its decoded body directly. For fetched
gzip, deflate and Brotli bodies, Core removes the upstream Content-Encoding and
Content-Length so Node frames the downstream stream correctly. It also removes
upstream connection-specific headers, including fields named by Connection.
Content-Type, Cache-Control, Last-Modified, cookies and application headers remain;
weak ETags remain, while unchanged strong ETags and representation-integrity fields
for a decoded representation are removed; middleware replacements survive final
transport sanitization. This includes RFC 9530 `Repr-Digest`, whose value depends on the
selected representation metadata and therefore changes when Content-Encoding is
removed. A decoded fetched 206 response, or decoded response carrying
Content-Range, fails through the normal framework error handler because Core cannot
recalculate encoded byte offsets for the decoded stream. Fetch provenance survives
Core normalization and middleware rewrapping the same body stream. Fetched HEAD/304
metadata and locally constructed responses, including production file assets, retain
their correct representation headers.

`defineServerMiddleware<Provides, Requires>()` defaults both types to `{}`.
Provided values are optional inside the providing callback until assigned, then
required downstream. Requirements must be supplied by earlier middleware or
inferred params. Group middleware may require prefix params; path and method
middleware may require prefix plus child params. Duplicate provided keys and
framework keys (`requestId`, `params`) are rejected. Both framework properties
are read-only. Global `serverMiddleware` accepts only middleware with empty
Provides and Requires, and receives `requestId` before route matching.

Paths are case-sensitive and normalize trailing slashes. Omit `prefix` when none
is needed; an explicitly supplied prefix must start with `/`, so `prefix: ''` is
invalid. Literal segments outrank `:params`, comparing segments from left to right.
Matching claims a path before
checking the method: an unsupported method returns 405 with `Allow`, without
falling through to a dynamic sibling or Vue. Core supplies GET-backed HEAD and
204 OPTIONS. Automatic OPTIONS and 405 skip route middleware; explicit OPTIONS
runs its route chain. Global middleware wraps all application-owned responses,
including legacy endpoints, production assets, non-HTML 404s, cached HTML and
SPA/SSR rendering. Framework health/readiness checks, private assets and
Vite-owned requests bypass it. Server routes bypass application preparation and
Vue SSR admission. Native response bodies stream with backpressure, and
`request.signal` follows the existing request deadline and disconnect lifecycle.

Fetch forbids constructing native Requests for TRACE, TRACK and CONNECT. If such
a method reaches the managed request handler, Core checks server-route ownership
before constructing a Request: a matched path returns 405 with that path's `Allow`;
an unmatched path follows the existing application/legacy fallback (normally a
non-HTML 404). These methods bypass all server middleware and never open the Web
body bridge. The Node transport still drains unread bodies. Node's separate
CONNECT/tunnel handling is not a server-route API.

In multi-app configuration, put `serverRoutes` on each `defineApplication()`;
`serverMiddleware` stays on `defineServer()`. Host selection isolates route tables.
Exact server-route paths suppress built-in SEO ownership of `/robots.txt` and
`/sitemap.xml`; overlap with a legacy endpoint’s explicit `ownedPaths` is a
configuration error. Legacy endpoints remain supported and may return `null` to
continue. Route patterns matching health/readiness paths are configuration errors.
Legacy response statuses 100–599 remain accepted. Informational 1xx responses
retain the existing Node transport behavior because native Response cannot
represent them; this does not add an informational-response/session API. With
server middleware, returning 1xx from the legacy continuation transfers control
out of the Web response chain: `next()` rejects with an internal transport transfer,
`finally` blocks run, and normal response decoration is skipped. A middleware
catch that returns its own Response replaces that result. Without server middleware,
legacy responses use the original transport directly. With middleware, unchanged
legacy headers retain their original values and multiplicity on the wire; changed
or deleted values follow Web Headers semantics. Legacy string bodies do
not acquire an implicit Content-Type.

`defineMiddleware()` remains **Vue navigation middleware**. HTTP middleware uses
`defineServerMiddleware()`. `serverRoutes` and `serverMiddleware` are server-only
and can import databases and Node modules; they never enter browser projection.
See the [complete server API example](./examples/4-server-api-app/) for
group, path, and method middleware together.

# HTTP Status Codes

```ts
import { redirectTo, setHttpStatus } from 'vue-ssr-lite'
setHttpStatus(404)
redirectTo('/new-location', { status: 308 })
```

`setHttpStatus()` sets the current HTTP/page status. During SSR this controls the HTTP response status; browser runtime state remains component-scoped according to the existing navigation lifecycle.

`redirectTo()` sets a validated HTTP redirect for the current server-rendered request. It does not perform Vue Router or browser-history navigation.

Status precedence is framework/route status, deepest matched route `meta.seo.status`, active `useSeo({ status })` layers, imperative `setHttpStatus()`, then an actual redirect response.

# Sitemap

Configure sitemap providers explicitly. There is no `sitemap.config.ts` convention.

```ts
export default defineServer({
  seo: {
    sitemap: async () => [{ loc: '/' }, { loc: '/about' }],
  },
})
```

Static Vue Router routes are discovered automatically. SPA / `noindex` branches are excluded unless provided explicitly.

```ts
import { defineSitemap, type SitemapContext } from 'vue-ssr-lite/server'
export const sitemap = defineSitemap(async (context: SitemapContext) => {
  const articles = await loadPublishedArticles(context.domain.hostname, {
    signal: context.signal,
  })
  return articles.map((article) => ({
    loc: `${context.siteOrigin}/blog/${article.slug}`,
    lastmod: article.updatedAt,
  }))
})
```

Large providers may return a sharded collection. Each sitemap file is limited to 50,000 URLs and 50 MB uncompressed. If `public/sitemap.xml` exists, that file is used instead.

# robots.txt

For a normal static policy, declare only the policy:

```ts
export default defineServer({
  seo: {
    robots: {
      groups: [{ userAgents: ['*'], allow: ['/'], disallow: ['/app', '/admin'] }],
    },
  },
})
```

When Core serves an application's sitemap, omitted `sitemaps` advertises that sitemap using the authoritative request origin. `sitemaps: [...]` uses exactly the supplied values, while `sitemaps: []` suppresses sitemap advertisement.

Use `resolve` only when tenant or publication policy requires a request-time decision; it returns the same configuration shape.

Private mode emits `Disallow: /`. If `public/robots.txt` exists, that file is used instead.

# Public Runtime Configuration

```ts
export default defineServer({
  publicConfig: ({ host, pathname, headers, domain }) => ({
    apiUrl: resolvePublicApi(host),
    locale: resolveLocale(headers['accept-language']),
    tenant: domain.params?.tenant,
  }),
})
```

```vue
<script setup lang="ts">
import { usePublicConfig } from 'vue-ssr-lite'
const config = usePublicConfig<{ apiUrl: string }>()
</script>
```

The factory runs server-side once per request that reaches application preparation. Server routes run before this step. Returned values must be JSON-safe and must never include credentials. Credential-bearing requests bypass the shared response cache.

# Site Origin

```ts
import { useOrigin } from 'vue-ssr-lite'
const origin = useOrigin()
```

`useOrigin()` reads the authoritative public origin for the current application/request.

By default, Core derives the origin from the normalized request domain after host selection and trusted-proxy processing. A non-empty result from the server-only `resolveSiteUrl()` is authoritative; an undefined, empty, or whitespace result falls through to `seo.siteUrl`, then `PUBLIC_URL`, then the normalized request origin. Enable `server.trustProxy` only behind a trusted reverse proxy.

# Domains

```ts
domain: {
  development: 'app.localhost',
  production: 'app.example.com',
  mode: 'root-and-subdomains',
  customDomains: true,
  params: {
    workspace: { source: 'last-subdomain-label' },
  },
}
```

```ts
import { useDomain } from 'vue-ssr-lite'
const domain = useDomain()
```

`useDomain()` reads the selected application's normalized domain information during SSR and after hydration. It exposes the selected application, normalized authority/hostname, base domain, subdomain, custom-domain flag, and declared domain params.

# Advanced useFetch

## `await useFetch()`

```ts
const { data } = await useFetch<ProductsResponse>('/api/products')
```

SSR:
`await useFetch()` waits for the initial request.

Browser:
`await useFetch()` does not wait for the network request.

Use `pending` for browser loading state, or `await refresh()` when you need to wait explicitly.

## Variables and reactive request identity

`variables` are normalized into query parameters. Arrays become repeated query
parameters, `null` becomes an empty value, and `undefined` is omitted.

The URL and `variables` may each be provided as plain values, refs, or getters.
When the resolved URL or variables change, the request identity changes and the
hook automatically switches to the corresponding request and runs it again.

## Fetch policies

The default policy is `network-only`.

```ts
useFetch('/api/products', {
  fetchPolicy: 'network-only',
})
```

Use `cache-first` when an existing successful value may be reused:

```ts
useFetch('/api/products', {
  fetchPolicy: 'cache-first',
})
```

For a hook that should fetch initially and prefer cache after its reactive identity changes:

```ts
useFetch('/api/products', {
  fetchPolicy: 'network-only',
  nextFetchPolicy: 'cache-first',
})
```

Identical in-flight requests are deduplicated even with `network-only`.

## Manual Fetching

```ts
const result = useFetch('/api/browser-only', {
  immediate: false,
})

await result.refresh()
```

Use `immediate: false` when you want to control when the first request runs.

## Client-only Requests

Set `server: false` when a request should not run during SSR:

```ts
const result = useFetch('/api/browser-only', {
  server: false,
})
```

During SSR the hook exposes its pending state without making the request. After hydration, the browser starts it normally. If `immediate: false` is also set, the request stays idle until `refresh()` is called.

## Full `setContext()` Behavior

Use `setContext()` to provide application-wide header defaults for future same-origin `useFetch()` executions. A common pattern is to set authentication after login or during application initialization:

```ts
import { setContext } from 'vue-ssr-lite'

setContext({
  headers: {
    authorization: `Bearer ${token}`,
  },
})
```

Pages can then fetch without repeating those headers:

```ts
const profile = useFetch('/api/profile')
```

Each call replaces the complete stored context; calls do not merge with earlier values. Supply the complete desired context after a token or workspace change. To remove the previous defaults on logout:

```ts
setContext({
  headers: {},
})
```

The change affects future executions only. Existing data and in-flight requests are unchanged, and `setContext()` does not automatically refetch mounted hooks. A later `refresh()` or reactive URL/variables execution uses the latest context. In-flight requests keep the context they started with.

Request-local headers take precedence over context defaults:

```ts
useFetch('/api/admin', {
  headers: {
    authorization: `Bearer ${adminToken}`,
  },
})
```

Context defaults are application scoped and same-origin only, so they are not automatically attached to third-party URLs. SSR applications keep this state isolated per request, and the context itself is never hydrated or serialized into the browser. Native clients remain unaffected.

## `context:false`

Use `context: false` when a request should skip stored defaults:

```ts
useFetch('/api/public-feed', {
  context: false,
})
```

This skips only `setContext()` defaults. It does not suppress the existing same-origin SSR forwarding of incoming cookies or authorization. Use both `context:false` and `credentials:'omit'` for an anonymous SSR request; explicitly supplied request headers still apply. Conversely, `credentials:'omit'` alone suppresses automatic SSR credential forwarding but does not delete headers supplied through `setContext()` or the request itself.

## Errors

Expected HTTP, network, parse, and timeout failures are exposed through `error`:

```ts
const { data, pending, error } = useFetch('/api/products', {
  timeout: 5_000,
})
```

`error.value.kind` is one of:

```text
http
network
parse
timeout
```

Normal request failures do not require `try/catch` around `useFetch()` or `refresh()`. Check `error` before relying on the result.

## Timeout and Cancellation

Use a normal `AbortSignal` when the caller needs cancellation:

```ts
const controller = new AbortController()

const result = useFetch('/api/products', {
  signal: controller.signal,
})

controller.abort()
```

Cancelling one hook does not cancel a shared physical request that another active hook still needs.

## Request Options

`useFetch()` supports GET and HEAD requests plus the common native fetch options:

```ts
useFetch('/api/products', {
  method: 'GET',
  headers: {
    'x-workspace': 'acme',
  },
  credentials: 'include',
  cache: 'no-store',
})
```

Supported request options include:

- `headers`
- `context`
- `credentials`
- `mode`
- `redirect`
- `referrer`
- `referrerPolicy`
- `integrity`
- native `cache`

`fetchPolicy` controls the `useFetch()` application cache. Native `cache` controls the browser/server HTTP fetch behavior. They are separate concepts.

## Callbacks

Use `onDone` and `onError` when an individual request execution needs a side effect:

```ts
useFetch<ProductsResponse>('/api/products', {
  onDone(ctx) {
    console.log(ctx.data, ctx.status)
  },
  onError(ctx) {
    console.log(ctx.error.kind, ctx.status)
  },
})
```

Callbacks belong to the requesting hook. They do not replay for hydration or cache hits.

## Other API Clients

`useFetch()` is optional. Native `fetch()`, Axios, Apollo / GraphQL, and other API clients continue to work normally.

Use `useFetch()` when you want the built-in SSR, hydration, reactive request state, deduplication, and lightweight cache behavior without adding another data-fetching library.

# Server Configuration

```ts
export default defineServer({
  server: {
    port: 3000,
    trustProxy: true,
  },
})
```

| Option                     | Description                                     |
| -------------------------- | ----------------------------------------------- |
| `host`                     | Bind address                                    |
| `port`                     | HTTP port                                       |
| `trustProxy`               | Trust reverse-proxy headers                     |
| `requestTimeoutMs`         | One request-wide deadline                       |
| `shutdownTimeoutMs`        | Graceful shutdown timeout                       |
| `maxConcurrentSsrRequests` | Active Vue SSR limit per server (default `8`)   |
| `maxQueuedSsrRequests`     | Waiting Vue SSR limit per server (default `32`) |
| `healthPath`               | Health endpoint                                 |
| `readinessPath`            | Readiness endpoint                              |
| `diagnostics`              | Development diagnostics                         |
| `logger`                   | Structured logger                               |
| `onMetrics`                | Render metrics callback                         |
| `renderError`              | Custom render-error response                    |

Only requests that reach Vue SSR consume this capacity. Cache hits, SPA HTML, server routes, legacy endpoints, health/readiness checks, Vite responses, and production assets bypass it. When both limits are full, the server returns `503 Service Unavailable`; queue time remains part of `requestTimeoutMs`. Set `maxQueuedSsrRequests: 0` to reject immediately whenever all active slots are occupied.

`PORT` overrides the configured port. A non-empty `HOST` overrides the configured bind host; whitespace-only `HOST` is ignored.

Application code supplies business data and policy. `vue-ssr-lite` owns SSR, HTTP, domain, origin, head, sitemap, and robots mechanics.

# Production

```bash
npm run build
NODE_ENV=production npm run start
```

```text
dist/
├── client/
└── server/
    └── SsrRuntime.js
```

Production public origins still require HTTPS by default. Set `seo.allowHttpOrigin` only for an intentional exception.

# CLI

```bash
vue-ssr-lite dev
vue-ssr-lite build
vue-ssr-lite start
```

```text
--root <path>
--config <path>
--server-output <path>
--hmr-port <port>
```

| Variable                | Description                           |
| ----------------------- | ------------------------------------- |
| `PORT`                  | Server port                           |
| `HOST`                  | Server bind host                      |
| `PUBLIC_URL`            | Optional fixed public origin override |
| `VUE_SSR_LITE_HMR_PORT` | Development HMR port                  |
| `NODE_ENV`              | Runtime environment                   |

# API Reference

## `vue-ssr-lite`

```ts
import {
  defineServer,
  defineServerRoutes,
  defineServerMiddleware,
  defineApplication,
  setContext,
  useFetch,
  useSeo,
  usePublicConfig,
  useOrigin,
  useDomain,
  redirectTo,
  setHttpStatus,
  defineExtension,
  defineMiddleware,
  RouterView,
  LoadingIndicator,
} from 'vue-ssr-lite'
import type { AppContext } from 'vue-ssr-lite'
```

| API                      | Purpose                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `defineServer`           | Configure the server/runtime                                         |
| `defineApplication`      | Register an explicit application                                     |
| `defineServerRoutes`     | Declare application HTTP routes with native Request/Response         |
| `defineServerMiddleware` | Declare typed HTTP middleware with Provides/Requires                 |
| `setContext`             | Replace same-origin header defaults for future `useFetch` executions |
| `useFetch`               | Fetch page data with SSR, hydration, typed refs, and caching         |
| `useSeo`                 | Set reactive SEO/head data                                           |
| `usePublicConfig`        | Read browser-safe server config                                      |
| `useOrigin`              | Read the authoritative public origin                                 |
| `useDomain`              | Read the selected normalized application domain                      |
| `setHttpStatus`          | Set the current HTTP/page status                                     |
| `redirectTo`             | Set a validated server-rendered-request redirect                     |
| `defineExtension`        | Create an advanced runtime extension                                 |
| `defineMiddleware`       | Create typed universal route middleware                              |
| `RouterView`             | Render routes with an optional delayed fallback                      |
| `LoadingIndicator`       | Show an optional delayed global navigation bar                       |
| `AppContext`             | Type for the `main.ts` initializer                                   |

## `vue-ssr-lite/vite`

```ts
import { vueSsrLite } from 'vue-ssr-lite/vite'
```

## `vue-ssr-lite/server`

Advanced genuinely server-only APIs:

```ts
import { defineSitemap, createSsrManagedServer, createSsrMemoryResponseCache } from 'vue-ssr-lite/server'
```

Beginner-facing configuration belongs in `vue-ssr-lite`, not this subpath.

# Universal vs Server-Only Code

These may contain private/server-only code:

```text
server.ts
SEO site resolvers
sitemap providers
robots providers
serverRoutes and their route middleware
serverMiddleware
legacy endpoints
```

These are universal/browser-capable:

```text
src/main.ts
src/App.vue
routes
pages
components
```

`defineApplication()` may mention routes and SEO in `app.ts`. The compiler projects a client graph from `main`, `App.vue`, and the routes module. It does not import the complete server configuration into browser bundles.

Six configuration fields are also projected into the browser: `extensions`, `middleware`, `router`, `scrollBehavior`, `createInitialState`, and `cleanup`. Core normally requires their dependencies to be universal and browser-safe. The only environment-specific exception is middleware on a statically proven default-SPA application, which never executes on the server and therefore uses its normal Vite browser dependency graph. This boundary keeps SEO, sitemap, robots, serverRoutes, serverMiddleware, legacy endpoints, Node APIs, secrets, and other server-only imports out of the browser bundle.

Use static inline expressions, direct imports from browser-safe modules, or dedicated `const` bindings whose dependencies are also static. A config stored in a `const` and the documented function/async export that directly returns `defineServer({...})` are supported too.

Core intentionally fails closed when a universal value is reassigned, mutated, passed to an unknown call or constructor, returned from an unrelated function, stored or exported through an unproven reference, or built through a dynamic factory.

Keep universal values in dedicated static bindings and keep server-only work outside their dependency graph. Unsupported indirection is a configuration error rather than a potentially different value after hydration.

# Advanced: Custom Extensions

```ts
import { defineExtension } from 'vue-ssr-lite'
const analytics = defineExtension({
  name: 'analytics',
  setup(context) {
    context.contributeHead({
      meta: [{ name: 'x-analytics', content: 'enabled' }],
    })
  },
})
```

Register extensions on `defineServer()` or `defineApplication()`, not in `main.ts`.

Projected fields (`extensions`, `middleware`, `router`, `scrollBehavior`, `createInitialState`, `cleanup`) follow the static projection contract above.

Prefer defining an extension inline or in a dedicated `const`;

`defineServer(factory())` and mutation-capable reference indirection are rejected because the server and browser definitions could silently diverge. The default-SPA middleware dependency exception changes only environment-equivalence validation;

it does not weaken these static identity and mutation checks.

# Common Problems

## Node APIs used in Vue code

Move Node-only work from `src/**` into `server.ts` or other server-only modules.

## Stateful Vue plugin shared between requests

Install the plugin inside the `main.ts` initializer so Core creates it per Vue application/request.

## Production origin rejected

Use an HTTPS request origin or configure an explicit HTTPS `PUBLIC_URL` / `seo.siteUrl`. HTTP requires the intentional `seo.allowHttpOrigin` exception.

## Wrong host/protocol behind a proxy

Use `server: { trustProxy: true }` only behind a trusted reverse proxy.

## Dynamic route missing from sitemap

Provide those URLs through `seo.sitemap`.

# License

MIT
