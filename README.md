# vue-ssr-lite

A lightweight SSR runtime for **Vue 3**.

`vue-ssr-lite` adds SSR, hydration, SEO, sitemaps, robots.txt, public runtime configuration, and production server tooling without requiring a full framework.

## Features

- Vue 3 + Vite SSR
- Automatic browser hydration
- Request-aware route CSS and module preloads
- Vue Router support
- Built-in SEO and head management
- Route SEO with `meta.seo`
- Route-level SSR/SPA with `meta.render`
- Universal global and route middleware
- Reactive page SEO with `useSeo()`
- Canonical URLs, Open Graph, Twitter cards, and JSON-LD
- HTTP status handling
- Explicit `/sitemap.xml` and `/robots.txt`
- Public server-to-client configuration
- Request-isolated Vue plugins such as Pinia
- Multiple SSR and SPA applications on one port
- Domain, subdomain, and custom-domain routing
- Optional SSR response caching
- Custom server endpoints
- Production CLI
- Advanced extension API

# Installation

```bash
npm install vue-ssr-lite vue-router
```

Requires Node `^20.19.0 || >=22.12.0` and an existing Vue 3 + Vite
application. Vue, Vue Router, and Vite remain host-owned peer dependencies; the
package does not install a private framework runtime.

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
project/
├── server.ts
└── src/
    ├── main.ts
    ├── App.vue
    ├── routes.ts
    └── pages/
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

Your Vue application is now SSR. You are ready to go.

If you need extra configuration or other features, continue below.

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

Use `domain` when routing varies by environment or needs subdomains, local
aliases, custom domains, additional hosts, or domain params:

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

`host` and `domain` are alternatives and cannot be used together on the same
application. Exact hosts outrank wildcard/subdomain matches, which outrank the
explicit `customDomains: true` catch-all. With no matching owner and no custom
domain catch-all, Core returns `421 Misdirected Request` with `No application
serves this host.`

`customDomains: true` means that the application may receive unmatched/custom
hosts. The application can then resolve the hostname against its own API or
database; Core does not impose a business-specific custom-domain verification
callback.

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

export const authMiddleware = defineMiddleware(async (context) => {
  const session = context.cookies.get('session')
  if (!session) {
    return {
      path: '/login',
      query: { redirect: context.to.fullPath },
    }
  }
  return { props: { userName: 'john' } }
})
```

Application-wide middleware is declared once in `server.ts` for a single app,
or on the relevant `defineApplication()` in multi-app mode:

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
  meta: { middleware: [authMiddleware] },
}
```

Global middleware runs on every navigation. Route middleware runs for route
records entered by the navigation, parent to child. A parent route's middleware
protects entry into that route branch, but it does not rerun when navigating
between descendants while the parent remains active. Leaving and later
re-entering the branch runs it again.

```text
/about → /dashboard
authMiddleware runs

/dashboard → /dashboard/nested
authMiddleware does not rerun

/dashboard/nested → /about → /dashboard/nested
authMiddleware runs again
```

The same function runs once per target navigation. Middleware may be synchronous
or async. Return nothing or `true` to continue, `false` to cancel, a normal Vue
Router location to redirect, or `{ props }` to add props to the default component
of the route that declared that middleware. Existing route props are composed,
with later middleware values winning. Accepted parent middleware props remain
owned by the parent component while that route record stays active.

On a direct SSR request, a middleware redirect becomes a real HTTP redirect and
the rejected component tree is not rendered. A direct SPA request still receives
the SPA shell first; middleware starts with the browser application navigation.
Use `context.redirect()` only for an explicit redirect status or intentional
external full-document navigation.

Middleware receives the current app/router, target and previous route, normalized
cookies, domain, authoritative origin, public config, environment flag, and an
abort signal. Global middleware configured in `server.ts` is statically projected
into the browser definition, so its complete dependency graph must be universal
and browser-safe.

Middleware should primarily handle navigation decisions such as authentication,
authorization, workspace resolution, redirects, and small route prerequisites.
Normal page data usually belongs in the page's query or data layer. When a valid
navigation check is async, it automatically participates in navigation loading.

# Navigation Loading

Wrap a route outlet to give that part of the page a custom delayed fallback:

```vue
<script setup lang="ts">
import { RouteSuspense } from 'vue-ssr-lite'
</script>

<template>
  <AppLayout>
    <Sidebar />
    <Header />

    <RouteSuspense :delay="120">
      <RouterView />

      <template #fallback>
        <PageSkeleton />
      </template>
    </RouteSuspense>
  </AppLayout>
</template>
```

`RouteSuspense` follows Vue Router automatically, including async middleware,
redirects, cancellation, other guards, and route component resolution. There
is no manual pending state. The current page remains mounted while navigation
is pending, and successful navigation loading settles after Vue has had a DOM
update tick to commit the accepted route. Only the wrapped route area exposes
the fallback, so persistent layout such as the sidebar and header stays in
place. Nested boundaries automatically select the closest outlet whose matched
route record is changing. Native Vue `<Suspense>` remains responsible for
arbitrary component-level async `setup()` and data dependencies.

The boundary containers use layout-transparent `display: contents` while
inactive and become a positioned loading surface only while a supplied
fallback covers the route area.

The fallback is optional and entirely application-owned. Quick navigations that
finish before the delay do not flash it. For a simple global bar, use the optional
CSS-animated indicator alone or together with a route fallback:

```vue
<script setup lang="ts">
import { LoadingIndicator } from 'vue-ssr-lite'
</script>

<template>
  <LoadingIndicator :delay="120" />
  <RouterView />
</template>
```

SSR renders the accepted route content directly and hydration does not show a
loader for that already-rendered page. A direct SPA load happens before Vue is
mounted, so keep a small static shell fallback in `index.html` for initial boot:

```html
<div id="app"></div>
<div class="initial-loader">Loading application…</div>

<style>
  #app:not(:empty) + .initial-loader {
    display: none;
  }
</style>
```

After mount, `RouteSuspense` and `LoadingIndicator` own subsequent browser
navigation feedback.

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

The resolver never runs in the browser. Core supplies `siteOrigin` from the
selected application's normalized request domain.

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

# HTTP Status Codes

```ts
import { redirectTo, setHttpStatus } from 'vue-ssr-lite'

setHttpStatus(404)
redirectTo('/new-location', { status: 308 })
```

`setHttpStatus()` sets the current HTTP/page status. During SSR this controls the
HTTP response status; browser runtime state remains component-scoped according
to the existing navigation lifecycle.

`redirectTo()` sets a validated HTTP redirect for the current server-rendered
request. It does not perform Vue Router or browser-history navigation.

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

When Core serves an application's sitemap, omitted `sitemaps` advertises that
sitemap using the authoritative request origin. `sitemaps: [...]` uses exactly
the supplied values, while `sitemaps: []` suppresses sitemap advertisement.
Use `resolve` only when tenant or publication policy requires a request-time
decision; it returns the same configuration shape.

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

The factory runs server-side once per request. Returned values must be JSON-safe and must never include credentials. Credential-bearing requests bypass the shared response cache.

# Site Origin

```ts
import { useOrigin } from 'vue-ssr-lite'

const origin = useOrigin()
```

`useOrigin()` reads the authoritative public origin for the current
application/request.

By default, Core derives the origin from the normalized request domain after
host selection and trusted-proxy processing. A non-empty result from the
server-only `resolveSiteUrl()` is authoritative; an undefined, empty, or
whitespace result falls through to `seo.siteUrl`, then `PUBLIC_URL`, then the
normalized request origin. Enable `server.trustProxy` only behind a trusted
reverse proxy.

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

Only requests that reach Vue SSR consume this capacity. Cache hits, SPA HTML,
custom endpoints, health/readiness checks, Vite responses, and production
assets bypass it. When both limits are full, the server returns `503 Service
Unavailable`; queue time remains part of `requestTimeoutMs`. Set
`maxQueuedSsrRequests: 0` to reject immediately whenever all active slots are
occupied.

`PORT` overrides the configured port. A non-empty `HOST` overrides the
configured bind host; whitespace-only `HOST` is ignored.

Application code supplies business data and policy. `vue-ssr-lite` owns
SSR, HTTP, domain, origin, head, sitemap, and robots mechanics.

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

Production public origins still require HTTPS by default. Set
`seo.allowHttpOrigin` only for an intentional exception.

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

| Variable                | Description              |
| ----------------------- | ------------------------ |
| `PORT`                  | Server port              |
| `HOST`                  | Server bind host         |
| `PUBLIC_URL`            | Optional fixed public origin override |
| `VUE_SSR_LITE_HMR_PORT` | Development HMR port     |
| `NODE_ENV`              | Runtime environment      |

# API Reference

## `vue-ssr-lite`

```ts
import {
  defineServer,
  defineApplication,
  useSeo,
  usePublicConfig,
  useOrigin,
  useDomain,
  redirectTo,
  setHttpStatus,
  defineExtension,
  defineMiddleware,
  RouteSuspense,
  LoadingIndicator,
} from 'vue-ssr-lite'
import type { AppContext } from 'vue-ssr-lite'
```

| API                 | Purpose                                            |
| ------------------- | -------------------------------------------------- |
| `defineServer`      | Configure the server/runtime                       |
| `defineApplication` | Register an explicit application                   |
| `useSeo`            | Set reactive SEO/head data                         |
| `usePublicConfig`   | Read browser-safe server config                    |
| `useOrigin`         | Read the authoritative public origin               |
| `useDomain`         | Read the selected normalized application domain    |
| `setHttpStatus`     | Set the current HTTP/page status                   |
| `redirectTo`        | Set a validated server-rendered-request redirect   |
| `defineExtension`   | Create an advanced runtime extension               |
| `defineMiddleware`  | Create typed universal route middleware            |
| `RouteSuspense`     | Add a delayed fallback around a changing route area |
| `LoadingIndicator`  | Show an optional delayed global navigation bar      |
| `AppContext`        | Type for the `main.ts` initializer                 |

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
server endpoints
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

Six configuration fields are also universal: `extensions`, `middleware`, `router`,
`scrollBehavior`, `createInitialState`, and `cleanup`. Core statically projects only
those fields and their proven browser-safe dependencies. This boundary keeps SEO,
sitemap, robots, endpoints, Node APIs, secrets, and other server-only imports out of
the browser bundle.

Use static inline expressions, direct imports from browser-safe modules, or dedicated
`const` bindings whose dependencies are also static. A config stored in a `const` and
the documented function/async export that directly returns `defineServer({...})` are
supported too.

Core intentionally fails closed when a universal value is reassigned, mutated,
passed to an unknown call or constructor, returned from an unrelated function,
stored or exported through an unproven reference, or built through a dynamic factory.
Keep universal values in dedicated static bindings and keep server-only work outside
their dependency graph. Unsupported indirection is a configuration error rather than
a potentially different value after hydration.

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

`useDomain()` reads the selected application's normalized domain information
during SSR and after hydration. It exposes the selected application, normalized
authority/hostname, base domain, subdomain, custom-domain flag, and declared
domain params.

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
Universal fields (`extensions`, `middleware`, `router`, `scrollBehavior`, `createInitialState`, `cleanup`)
follow the static projection contract above. Prefer defining an extension inline or
in a dedicated `const`; `defineServer(factory())` and mutation-capable reference
indirection are rejected because the server and browser definitions could silently
diverge.

# Common Problems

## Node APIs used in Vue code

Move Node-only work from `src/**` into `server.ts` or other server-only modules.

## Stateful Vue plugin shared between requests

Install the plugin inside the `main.ts` initializer so Core creates it per Vue application/request.

## Production origin rejected

Use an HTTPS request origin or configure an explicit HTTPS `PUBLIC_URL` /
`seo.siteUrl`. HTTP requires the intentional `seo.allowHttpOrigin` exception.

## Wrong host/protocol behind a proxy

Use `server: { trustProxy: true }` only behind a trusted reverse proxy.

## Dynamic route missing from sitemap

Provide those URLs through `seo.sitemap`.

# License

MIT
