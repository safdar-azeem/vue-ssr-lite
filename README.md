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

# Minimal Setup

## 1. Add the Vite plugin

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vueSsrLite } from 'vue-ssr-lite/vite'

export default defineConfig({
  plugins: [vue(), vueSsrLite()],
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

# Vue Plugins

Install stateful plugins inside `main.ts` so each Vue application/request gets a fresh instance:

```ts
export default ({ app }: AppContext) => {
  app.use(createPinia())
}
```

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
import { setResponseRedirect, setResponseStatus } from 'vue-ssr-lite'

setResponseStatus(404)
setResponseRedirect('/new-location', { status: 308 })
```

Status precedence is framework/route status, deepest matched route `meta.seo.status`, active `useSeo({ status })` layers, imperative `setResponseStatus()`, then an actual redirect response.

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

```ts
export default defineServer({
  seo: {
    robots: {
      resolve: async ({ siteOrigin }) => ({
        status: 'resolved',
        config: {
          groups: [
            {
              userAgents: ['*'],
              allow: ['/'],
              disallow: ['/app', '/admin'],
            },
          ],
          sitemaps: [`${siteOrigin}/sitemap.xml`],
        },
      }),
    },
  },
})
```

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
import { useSiteOrigin } from 'vue-ssr-lite'

const origin = useSiteOrigin()
```

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

`PORT` can override the configured port.

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
  useSiteOrigin,
  setResponseRedirect,
  setResponseStatus,
  defineExtension,
} from 'vue-ssr-lite'
import type { AppContext } from 'vue-ssr-lite'
```

| API                   | Purpose                              |
| --------------------- | ------------------------------------ |
| `defineServer`        | Configure the server/runtime         |
| `defineApplication`   | Register an explicit application     |
| `useSeo`              | Set reactive SEO/head data           |
| `usePublicConfig`     | Read browser-safe server config      |
| `useSiteOrigin`       | Read resolved public origin          |
| `setResponseStatus`   | Set SSR status and component-scoped browser status |
| `setResponseRedirect` | Set a validated server redirect      |
| `defineExtension`     | Create an advanced runtime extension |
| `AppContext`          | Type for the `main.ts` initializer   |

## `vue-ssr-lite/vite`

```ts
import { vueSsrLite } from 'vue-ssr-lite/vite'
```

## `vue-ssr-lite/server`

Advanced genuinely server-only APIs:

```ts
import { defineSitemap, createSsrManagedServer, createSsrMemoryResponseCache, useSsrDomain } from 'vue-ssr-lite/server'
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

Five configuration fields are also universal: `extensions`, `router`,
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

# Advanced: Domains

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
import { useSsrDomain } from 'vue-ssr-lite/server'

const domain = useSsrDomain()
```

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
Universal fields (`extensions`, `router`, `scrollBehavior`, `createInitialState`, `cleanup`)
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
