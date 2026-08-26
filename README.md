# vue-ssr-lite

A lightweight Server-Side Rendering (SSR) runtime for **Vue 3**.

`vue-ssr-lite` adds SSR, hydration, SEO, sitemaps, robots.txt, public runtime configuration, and production server tooling without requiring a full framework.

## Features

- Vue 3 + Vite SSR
- Automatic browser hydration
- Request-aware route CSS and module preloads
- Vue Router support
- Built-in SEO and head management
- Route SEO with `meta.seo`
- Reactive page SEO with `useSeo()`
- Canonical URLs, Open Graph, Twitter cards, and JSON-LD
- HTTP status handling
- Automatic `/sitemap.xml` and `/robots.txt`
- Dynamic sitemap support
- Public server-to-client configuration
- Vue plugin support
- Multiple SSR and SPA applications
- Domain, subdomain, and custom-domain routing
- Optional SSR response caching
- Custom server endpoints
- Production CLI
- Advanced extension API

# Installation

```bash
npm install vue-ssr-lite vue-router
```

Or:

```bash
yarn add vue-ssr-lite vue-router
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

## 3. Define the application

Replace manual `createApp().mount()` with `defineApplication()`:

```ts
// src/main.ts
import './style.css'

import { defineApplication } from 'vue-ssr-lite'
import App from './App.vue'
import { routes } from './router/routes'

export default defineApplication({
  root: App,
  routes,
})
```

## 4. HTML Entry (`index.html`)

Keep your standard Vite `index.html` at the project root. No special SSR markup is required:

## 5. Start development

```bash
npm run dev
```

Your Vue pages now render on the server and hydrate in the browser.

---

# Vue Plugins

For stateful plugins such as Pinia, use a factory:

```ts
import { createPinia } from 'pinia'

export default defineApplication({
  root: App,
  routes,

  plugins: () => [createPinia()],
})
```

This creates an isolated plugin instance for each SSR application/request.

---

# Application Configuration

`defineApplication()` is the main application API:

```ts
export default defineApplication({
  root: App,
  routes,

  seo: {
    siteName: 'My App',
    titleTemplate: '%s | My App',
  },
})
```

Common options:

| Option               | Description                    |
| -------------------- | ------------------------------ |
| `root`               | Root Vue component             |
| `routes`             | Vue Router routes              |
| `router`             | Advanced custom router factory |
| `scrollBehavior`     | Router scroll behavior         |
| `plugins`            | Vue plugins                    |
| `seo`                | Global SEO defaults            |
| `install`            | Application setup hook         |
| `createInitialState` | Initial application state      |
| `cleanup`            | Application cleanup hook       |
| `extensions`         | Advanced custom SSR extensions |

---

# SEO

SEO is composed from four public layers:

1. Application defaults with `defineApplication({ seo })`
2. Request-resolved site defaults with server-only `siteSeo`
3. Matched route records, parent to child, with `meta.seo`
4. Active page/component layers with `useSeo()` in registration order

Later layers win for singleton fields. `null` clears an inherited string,
nested object, or collection where the field type permits it. Metadata, links,
structured data, Open Graph media, and hreflang use identity-aware composition
rather than a generic deep merge. A lower-level custom managed-head extension
can intentionally override the completed SEO contribution.

## Global SEO

```ts
export default defineApplication({
  root: App,
  routes,

  seo: {
    siteName: 'My Store',
    title: 'Home',
    titleTemplate: '%s | My Store',
    description: 'My online store.',
    image: 'https://example.com/social.png',
    index: true,
    follow: true,
    siteUrl: 'https://example.com',
    htmlAttributes: { lang: 'en', dir: 'ltr' },
  },
})
```

Common options:

| Option          | Description                       |
| --------------- | --------------------------------- |
| `siteName`      | Site name                         |
| `title`         | Default title                     |
| `titleTemplate` | Title template                    |
| `description`   | Default description               |
| `image`         | Default social image              |
| `siteUrl`       | Public site origin                |
| `trailingSlash` | Canonical trailing-slash behavior |
| `mode`          | `public` or `private`             |
| `enabled`       | Enable/disable built-in SEO       |
| `robotsTxt`     | robots.txt rules                  |

Application and request-resolved site defaults cannot own page identities:
`canonical`, `status`, `sitemap`, first-class `alternates.languages`, or
`openGraph.url`. Their generic `meta` and `links` arrays also cannot recreate a
canonical, hreflang link, or `og:url`. A global `rel="alternate"` without
`hreflang` remains valid for RSS/Atom feeds.

## Request-resolved site SEO

Website builders and multi-tenant applications can resolve public site
defaults once per server request:

```ts
// ssr.config.ts
import { defineSsrConfig, type SiteSeoResolution } from 'vue-ssr-lite/server'

export default defineSsrConfig({
  resolveSiteUrl: async (request) => lookupAuthoritativeOrigin(request),

  siteSeo: {
    resolve: async ({ applicationId, siteOrigin, domain, signal }): Promise<SiteSeoResolution> => {
      const site = await database.sites.byDomain(domain.hostname, { signal })
      if (!site) return { status: 'not-found', responseStatus: 404 }

      return {
        status: 'resolved',
        defaults: {
          siteName: site.name,
          title: site.defaultTitle,
          titleTemplate: site.titleTemplate,
          description: site.description,
          image: site.socialImage,
          index: site.published,
          follow: site.published,
          structuredData: site.structuredData,
        },
        revision: site.seoRevision,
        cacheTags: [`site:${site.id}`],
      }
    },
  },
})
```

For multi-application configuration, put `siteSeo` on the relevant
`applications.<id>` entry. `SiteSeoContext` is deliberately site-stable: it
contains `applicationId`, `siteOrigin`, `domain`, and `signal`, but no pathname,
search, or `publicConfig`.

The resolver never runs in the browser. Its validated public defaults are
serialized into hydration state, restored exactly, and retained across
same-origin SPA navigation. Moving to another tenant/origin requires a full
document navigation. Provider revision and cache tags remain server-only.

Return `status: 'not-found'` for an unknown tenant. It fails closed with HTTP
404 (or explicitly 421), emits no normal tenant snapshot or canonical, skips
sitemap/robots tenant providers, and bypasses normal response caching. An
existing but unpublished tenant instead returns `status: 'resolved'` with
`index: false` and/or `follow: false`. Resolver errors and aborts are failures,
not tenant-not-found results.

## Route SEO

```ts
export const routes = [
  {
    path: '/',
    component: HomeView,
    meta: {
      seo: {
        title: 'Home',
        description: 'Welcome to our website.',
      },
    },
  },
  {
    path: '/:pathMatch(.*)*',
    component: NotFoundView,
    meta: {
      seo: {
        title: 'Page Not Found',
        status: 404,
      },
    },
  },
]
```

## `useSeo()`

Use `useSeo()` when metadata depends on page data:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { useSeo } from 'vue-ssr-lite'

const props = defineProps<{
  product: {
    name: string
    description: string
    image: string
  }
}>()

useSeo(computed(() => ({
  title: props.product.name,
  description: props.product.description,
  image: props.product.image,
  status: props.product ? 200 : 404,
})))
</script>
```

Useful fields:

```ts
useSeo({
  title: 'Product',
  description: 'Product description',
  image: 'https://example.com/product.png',
  canonical: '/products/item',
  index: true,
  follow: true,

  openGraph: {
    type: 'product',
    url: '/products/item',
    siteName: 'My Store',
    locale: 'en_US',
    localeAlternate: ['fr_FR'],
    image: [
      { key: 'primary', url: '/product.png', width: 1200, height: 630, alt: 'Product' },
      { url: '/detail.png' },
    ],
  },

  twitter: {
    card: 'summary_large_image',
    site: '@store',
    creator: '@author',
  },

  alternates: {
    languages: {
      en: '/products/item',
      fr: '/fr/produits/item',
      'x-default': '/products/item',
    },
  },
})
```

`useSeo()` accepts a plain object, `Ref<SeoPageInput>`, computed ref, or a
whole-object getter. Individual fields can also be plain values, refs,
computed refs, or getters. Application/data code owns fetching; SEO consumes
the already-resolved reactive object.

Active layers are scoped to their component. Reactive updates, KeepAlive
activation/deactivation, unmount, route navigation, Back, and Forward all
recalculate the effective head and declarative status.

Clearing examples:

```ts
useSeo({
  title: null,             // clear an inherited title
  openGraph: null,         // clear inherited OG fields
  meta: null,              // clear the inherited generic meta collection
  links: null,
  structuredData: null,
  alternates: {
    languages: { fr: null }, // remove the inherited French hreflang
  },
})
```

First-class hreflang is page/route/component-only. Site-wide
`htmlAttributes.lang` sets document language; it is not a hreflang set.

## Structured Data

```ts
useSeo({
  structuredData: [
    {
      '@context': 'https://schema.org',
      '@id': 'https://example.com/products/example#product',
      '@type': 'Product',
      name: 'Example Product',
    },
    { '@type': 'BreadcrumbList', itemListElement: [] },
  ],
})
```

JSON-LD remains schema-generic. Blocks append by default; a later block with
the same `@id` replaces that identity, while unkeyed blocks remain independent.
Use `structuredDataMode: 'replace'` to replace lower layers explicitly.
Serialization protects against script breakout.

Open Graph `image`, `audio`, and `video` values are repeatable. An explicit
`key` replaces an earlier item with the same key; unkeyed entries always append,
even when their URLs match. The page-level `image` is the primary fallback.

## Custom Meta and Link Tags

```ts
useSeo({
  meta: [{ name: 'theme-color', content: '#ffffff' }],

  links: [
    {
      rel: 'alternate',
      hreflang: 'es',
      href: 'https://example.com/es',
    },
  ],
})
```

---

# HTTP Status Codes

For a static route:

```ts
{
  path: '/:pathMatch(.*)*',
  component: NotFoundView,
  meta: {
    seo: {
      status: 404,
      title: 'Page Not Found',
    },
  },
}
```

For dynamic data:

```ts
import { computed } from 'vue'
import { useSeo } from 'vue-ssr-lite'

const article = await fetchArticle()

useSeo(computed(() => article
  ? { title: article.title, status: 200 }
  : { title: 'Article Not Found', status: 404 }
))
```

Status precedence is framework/route status, deepest matched route
`meta.seo.status`, active `useSeo({ status })` layers, imperative
`setResponseStatus()`, then an actual redirect response. Use
`setResponseStatus()` for imperative Core HTTP logic and when SEO is disabled.

Use the Core redirect helper for redirects:

```ts
import { setResponseRedirect } from 'vue-ssr-lite'

setResponseRedirect('/new-location', { status: 308 })
setResponseRedirect('https://external.example/path', {
  status: 302,
  allowExternal: true,
})
```

The default status is 302 and external redirects are rejected unless allowed.
Only credential-free HTTP(S) locations without control characters are valid.
The helper records server response state; it is a no-op in the browser and
never performs Router navigation. Generic headers remain available through
`useSsrRequestContext().response.headers`; there is no `setResponseHeader()`.

404 and 410 responses retain their real status, become `noindex` without an
invented `nofollow`, omit automatic canonical/structured data, stay out of
static sitemaps, and bypass normal page caching. 5xx and redirects similarly
suppress normal indexable output. A 3xx status without a redirect is rejected.

## Canonical and `og:url`

Core resolves one authoritative site origin:

```text
resolveSiteUrl(request) → seo.siteUrl → PUBLIC_URL → validated development fallback
```

When configured, `resolveSiteUrl()` is authoritative; `PUBLIC_URL` cannot
override it. Missing/invalid resolution fails closed in public production. The
same origin drives canonical, `og:url`, hreflang, sitemap URLs, and robots
sitemap lines. Canonical and `openGraph.url` must remain same-origin and use
credential-free HTTP(S).

`canonical` is page-owned. A string sets it; `false` suppresses it; `null`
clears an inherited value. On a successful normal page, omission follows the
normal current-page canonical behavior. Explicit page `openGraph.url` wins,
then effective canonical, then the normalized current page URL. Explicit
`canonical: false` or `null` prevents automatic `og:url` derivation.

---

# Sitemap

The library automatically serves:

```text
/sitemap.xml
```

Static Vue Router routes are discovered automatically.

For dynamic routes such as `/blog/:slug`, create:

```ts
// sitemap.config.ts
import { defineSitemap, type SitemapContext } from 'vue-ssr-lite/server'

export default defineSitemap(async (context: SitemapContext) => {
  const articles = await loadPublishedArticles(context.domain.hostname, {
    signal: context.signal,
  })

  return articles.map((article) => ({
    loc: `${context.siteOrigin}/blog/${article.slug}`,
    lastmod: article.updatedAt,
    changefreq: 'weekly',
    priority: 0.7,
    alternates: article.localizedUrls,
    images: article.image ? [{ loc: article.image }] : undefined,
  }))
})
```

Supported entry shape:

```ts
{
  loc: '/blog/example',
  lastmod: new Date(),
  changefreq: 'weekly',
  priority: 0.8,
  alternates: { en: '/blog/example', fr: '/fr/blog/example' },
  images: [{ loc: 'https://cdn.example/image.jpg' }],
  videos: [{
    thumbnailLoc: 'https://cdn.example/thumb.jpg',
    title: 'Example video',
    description: 'Example description',
    playerLoc: 'https://video.example/player',
  }],
  news: {
    publication: { name: 'Example News', language: 'en' },
    publicationDate: new Date(),
    title: 'Example article',
  },
}
```

Dynamic providers declare published, canonical/indexable records; the framework
does not render every dynamic page. Page `loc` and hreflang URLs are same-origin
by default. Approved image/video media may be cross-origin. Entries are
deduplicated and XML-escaped. Invalid schemes, credentials, extension data, or
cross-tenant page URLs fail the response atomically.

Each sitemap file is limited to 50,000 URLs and 50 MB uncompressed. Each page
supports at most 1,000 images, each sitemap at most 1,000 News entries, and each
video must meet the required URL/text/date/duration/tag bounds.

## Large sharded sitemaps

Large providers return a replayable shard collection:

```ts
export default defineSitemap(async (context) => ({
  kind: 'sharded',
  revision: await currentSitemapRevision(context.domain.hostname),
  shardCount: await countSitemapShards(context.domain.hostname),
  lastModified: new Date(),
  cacheControl: 'public, max-age=300',
  getShard: async (shardContext, shardNumber) =>
    streamPublishedPages(shardContext.domain.hostname, shardNumber, {
      signal: shardContext.signal,
    }),
}))
```

`/sitemap.xml` becomes the index. Shard numbers are 1-based:
`/sitemap-1.xml` calls `getShard(context, 1)`. Revision is mandatory, content
must be deterministic for that revision, and only one shard is held/serialized
at a time. Every shard independently satisfies URL, byte, and extension limits.

Bare arrays/iterables remain compatible for small sites. Return
`{ kind: 'entries', entries, revision, lastModified, cacheControl }` when a
non-sharded sitemap needs HTTP metadata. A provider can return
`{ status: 'not-found', responseStatus: 404 | 421 }` when `siteSeo` is absent.
When `siteSeo` exists, it is the authoritative tenant gate and is resolved
before sitemap or robots providers.

If `public/sitemap.xml` exists, the physical file is used instead.

---

# robots.txt

The library automatically serves:

```text
/robots.txt
```

Custom rules:

```ts
export default defineApplication({
  root: App,
  routes,

  seo: {
    robotsTxt: {
      groups: [
        { userAgents: '*', allow: ['/'], disallow: ['/admin/', '/private/'] },
        { userAgents: 'Googlebot', allow: ['/public-search/'] },
      ],
      sitemaps: ['https://example.com/sitemap.xml'],
    },
  },
})
```

Legacy `allow`/`disallow` shorthand remains supported and normalizes to one
`User-agent: *` group. Do not mix shorthand with `groups`.

Website builders can resolve robots policy per tenant on the server:

```ts
export default defineSsrConfig({
  siteRobots: {
    resolve: async ({ domain, siteOrigin, pathname, search, signal }) => ({
      status: 'resolved',
      config: {
        groups: [{ userAgents: '*', allow: ['/'], disallow: ['/admin'] }],
        sitemaps: [`${siteOrigin}/sitemap.xml`],
      },
      revision: await robotsRevision(domain.hostname, { signal }),
      cacheControl: 'public, max-age=300',
    }),
  },
})
```

`SiteRobotsContext` includes endpoint pathname/search but not `publicConfig`.
Resolution order is private mode, dynamic `siteRobots`, static `robotsTxt`, then
the public wildcard default. Private mode skips the resolver and emits
`Disallow: /`. This is crawler guidance, not authentication or access control.

Supplementary meta robots directives support `nosnippet`, `noimageindex`,
`maxSnippet`, `maxImagePreview`, `maxVideoPreview`, `notranslate`,
`indexifembedded`, `unavailableAfter`, and `noarchive`. `additional` is a
validated future escape hatch; first-class directive names are reserved.
Control characters and invalid names are rejected.

Sitemap and robots result metadata maps `revision` to ETag, `lastModified` to
Last-Modified, and validated `cacheControl` to Cache-Control. Conditional
If-None-Match and If-Modified-Since requests return 304 when appropriate.
`SeoProviderMeta` on `siteSeo` is not endpoint HTTP metadata.
Provider exceptions fail the endpoint with a non-cacheable service error;
request aborts stop provider/shard work and prevent cache writes. Invalid or
oversized sitemap output is never returned partially.

If `public/robots.txt` exists, that file is used instead.

---

# Public Runtime Configuration

Use `publicConfig` to pass browser-safe server configuration into Vue.

## Static server configuration

```ts
export default defineSsrConfig({
  publicConfig: {
    apiUrl: 'https://api.example.com',
  },
})
```

## Server factory

```ts
// ssr.config.ts
import { defineSsrConfig, requireSsrEnv } from 'vue-ssr-lite/server'

export default defineSsrConfig({
  publicConfig: () => ({
    apiUrl: requireSsrEnv('PUBLIC_API_URL'),
    environment: requireSsrEnv('NODE_ENV'),
  }),
})
```

Existing zero-argument factories remain supported. For request-aware public
configuration, use the resolved server request descriptor:

```ts
export default defineSsrConfig({
  publicConfig: ({ host, pathname, headers, domain }) => ({
    apiUrl: resolvePublicApi(host),
    locale: resolveLocale(headers['accept-language']),
    tenant: domain.params?.tenant,
    checkout: pathname.startsWith('/checkout'),
  }),
})
```

The factory runs server-side exactly once per incoming request, after proxy,
host, application, and domain resolution. Async factories receive the
request-wide `signal`. The resolved, immutable request snapshot is used for SSR
or SPA bootstrap and is sent to the browser; the browser does not run the
factory.

## Vue

```vue
<script setup lang="ts">
import { usePublicConfig } from 'vue-ssr-lite'

interface PublicConfig {
  apiUrl: string
  environment: string
}

const config = usePublicConfig<PublicConfig>()
</script>
```

`publicConfig` is sent to the browser. Request headers may contain credentials:
never copy `Authorization`, `Cookie`, `Proxy-Authorization`, private tokens,
passwords, private keys, database credentials, or other secrets into the
returned object. Returned configuration must contain JSON-safe values: null,
booleans, finite numbers, strings, dense arrays, and plain objects composed of
those values. Negative zero is normalized to zero.

Rendered-response cache keys automatically vary by application, protocol,
host, pathname, search, resolved public config, authoritative site origin, and
the deterministic validated site SEO snapshot. Consumers do not need
`responseCache.vary` for SEO correctness. Use it only for an additional public
render discriminator outside those framework-owned inputs. Credential-bearing
requests continue to bypass the shared response cache. Tenant-not-found,
redirected, private, error, failed, and aborted responses are not normal page
cache entries.

---

# Site Origin

Read the resolved public origin:

```ts
import { useSiteOrigin } from 'vue-ssr-lite'

const origin = useSiteOrigin()
```

For a public production site, configure either:

```ts
seo: {
  siteUrl: 'https://example.com',
}
```

or:

```bash
PUBLIC_URL=https://example.com
```

Custom-domain applications should configure server-only `resolveSiteUrl()`.
Its validated result is authoritative and outranks both `seo.siteUrl` and
`PUBLIC_URL`. The runtime honors trusted-proxy protocol/host information only
when `server.trustProxy` is enabled; the resolver must validate host ownership.
Public production requests fail closed if an authoritative resolver returns a
missing, malformed, insecure, credentialed, or unbound origin.

---

# Server Configuration

`ssr.config.ts` is optional.

Use it for server settings or advanced application routing:

```ts
// ssr.config.ts
import { defineSsrConfig } from 'vue-ssr-lite/server'

export default defineSsrConfig({
  server: {
    port: 3000,
    trustProxy: true,
  },
})
```

Common server options:

| Option              | Description                  |
| ------------------- | ---------------------------- |
| `host`              | Bind address                 |
| `port`              | HTTP port                    |
| `trustProxy`        | Trust reverse-proxy headers  |
| `requestTimeoutMs`  | One request-wide deadline    |
| `shutdownTimeoutMs` | Graceful shutdown timeout    |
| `healthPath`        | Health endpoint              |
| `readinessPath`     | Readiness endpoint           |
| `diagnostics`       | Development diagnostics      |
| `logger`            | Structured logger            |
| `onMetrics`         | Render metrics callback      |
| `renderError`       | Custom render-error response |

`PORT` can override the configured port.

`requestTimeoutMs` starts when the application request is accepted and is not
restarted between configuration, origin, endpoint, cache, template, or render
stages. The same `request.signal` is aborted on disconnect, deadline expiry,
and normal response completion so cooperative request work can stop. Logger and
metrics callbacks are best effort: their failures never replace an HTTP
response. A custom `renderError` handler is also bounded during failure
responses, including after a request timeout.

---

# Production

Build:

```bash
npm run build
```

Output:

```text
dist/
├── client/
└── server/
    └── SsrRuntime.js
```

Start:

```bash
NODE_ENV=production npm run start
```

For a public site:

```bash
PUBLIC_URL=https://example.com
```

An authoritative production origin is required for public SSR applications
with SEO enabled. SPA entries do not inherit that SSR-only requirement.

Behind a trusted reverse proxy:

```ts
export default defineSsrConfig({
  server: {
    trustProxy: true,
  },
})
```

---

# CLI

```bash
vue-ssr-lite dev
vue-ssr-lite build
vue-ssr-lite start
```

Useful options:

```text
--root <path>
--config <path>
--server-output <path>
--hmr-port <port>
```

Environment variables:

| Variable                | Description              |
| ----------------------- | ------------------------ |
| `PORT`                  | Server port              |
| `PUBLIC_URL`            | Public production origin |
| `VUE_SSR_LITE_HMR_PORT` | Development HMR port     |
| `NODE_ENV`              | Runtime environment      |

---

# API Reference

## `vue-ssr-lite`

```ts
import {
  defineApplication,
  useSeo,
  usePublicConfig,
  useSiteOrigin,
  setResponseRedirect,
  setResponseStatus,
  defineExtension,
} from 'vue-ssr-lite'
```

| API                   | Purpose                              |
| --------------------- | ------------------------------------ |
| `defineApplication`   | Define the universal Vue application |
| `useSeo`              | Set reactive SEO/head data           |
| `usePublicConfig`     | Read browser-safe server config      |
| `useSiteOrigin`       | Read resolved public origin          |
| `setResponseStatus`   | Set imperative SSR HTTP status       |
| `setResponseRedirect` | Set a validated server redirect      |
| `defineExtension`     | Create an advanced runtime extension |

## `vue-ssr-lite/vite`

```ts
import { vueSsrLite } from 'vue-ssr-lite/vite'
```

## `vue-ssr-lite/server`

```ts
import {
  defineSsrConfig,
  defineSitemap,
  createSsrManagedServer,
  createSsrMemoryResponseCache,
  useSsrDomain,
} from 'vue-ssr-lite/server'
```

| API                            | Purpose                              |
| ------------------------------ | ------------------------------------ |
| `defineSsrConfig`              | Configure the server/runtime         |
| `defineSitemap`                | Provide dynamic sitemap URLs         |
| `createSsrManagedServer`       | Advanced programmatic server hosting |
| `createSsrMemoryResponseCache` | Optional in-memory response cache    |
| `useSsrDomain`                 | Read domain context and build URLs   |

Server configuration helpers and their related public types are exported
explicitly. Asset serving, host matching, HTML transformation, config compiler,
site-origin enforcement, and raw render mechanics are internal implementation
details and are not package contracts.

## `vue-ssr-lite/client`

The client entry is intended for generated bootstrap code and advanced custom
integrations. It explicitly exports `hydrateSsrApplication`,
`mountSpaApplication`, domain helpers, SSR-safe watchers, and the hydration /
resolution integration contracts. Normal application code should import from
`vue-ssr-lite`.

---

# Advanced: Universal vs Server-Only Code

Files inside normal Vue application code such as:

```text
src/**
```

can execute both on the server and in the browser.

Do not use Node-only modules, database clients, or private secrets directly in universal Vue code.

Use server-only locations such as:

```text
ssr.config.ts
sitemap.config.ts
server/**
```

for Node-only work.

---

# Advanced: Multiple Applications

One server can host multiple applications:

```ts
export default defineSsrConfig({
  applications: {
    website: {
      app: './src/website/main.ts',
      template: './index.html',
      host: 'example.com',
    },

    admin: {
      app: './src/admin/main.ts',
      template: './admin.html',
      host: 'admin.example.com',
    },
  },
})
```

The object key is the application ID. Each application must use a distinct
physical HTML template; equivalent paths to the same template are rejected.

## SSR and SPA Together

```ts
export default defineSsrConfig({
  applications: {
    website: {
      app: './src/website/main.ts',
      template: './index.html',
      host: 'example.com',
      render: 'ssr',
    },

    admin: {
      app: './src/admin/main.ts',
      template: './admin.html',
      host: 'admin.example.com',
      render: 'spa',
    },
  },
})
```

---

# Advanced: Domains and Subdomains

```ts
export default defineSsrConfig({
  applications: {
    app: {
      app: './src/app/main.ts',

      domain: {
        development: 'app.localhost',
        production: 'app.example.com',
        mode: 'root-and-subdomains',
        customDomains: true,
      },
    },
  },
})
```

Available modes:

```text
root
subdomains
root-and-subdomains
```

## Domain Parameters

```ts
domain: {
  production: 'app.example.com',

  params: {
    workspace: {
      source: 'last-subdomain-label',
    },
  },
}
```

For `acme.app.example.com`, `workspace` becomes `acme`.

## `useSsrDomain()`

```ts
import { useSsrDomain } from 'vue-ssr-lite/server'

const domain = useSsrDomain()

domain.hostname
domain.baseDomain
domain.subdomain
domain.isCustomDomain
domain.params
```

Build another subdomain URL:

```ts
const url = domain.buildSubdomainUrl('billing', '/invoices')
```

Implicit URLs use the request's resolved protocol and authority, including a
non-default development port. Explicit `protocol` and `port` options override
those request values consistently during SSR and hydration.

---

# Advanced: Vue Teleports

Vue Teleports retain their native SSR target map. Use dedicated simple-id
containers outside the application mount:

```html
<div id="app"></div>
<div id="modals"></div>
<div id="toasts"></div>
```

Targets may be `body`, `head`, or a simple id selector such as `#modals`.
The application mount must also be an empty dedicated container apart from
formatting whitespace.
Dedicated id targets must be empty apart from formatting whitespace. Missing,
unsafe, non-empty, or mount-element targets fail with an actionable template
error instead of silently placing content in the wrong container.

---

# Advanced Server Options

These features are optional. Most applications do not need them.

## Cookie Forwarding

```ts
export default defineSsrConfig({
  cookies: {
    allow: ['session', 'locale'],
  },
})
```

`deny` is also supported.

## Custom Endpoints

```ts
export default defineSsrConfig({
  endpoints: [
    {
      id: 'example',

      match: (request) => request.pathname === '/api/example',

      handle: async () => ({
        statusCode: 200,
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ok: true }),
      }),
    },
  ],
})
```

## SSR Response Cache

```ts
export default defineSsrConfig({
  responseCache: {
    store: myCacheStore,
    ttlMs: 60_000,
  },
})
```

Advanced strategies may also define:

```ts
responseCache: {
  store,
  ttlMs: 60_000,
  vary: async (request) => 'en',
  tags: async () => ['website:123'],
  shouldCache: (response) => response.statusCode === 200,
}
```

Requests with non-empty `Cookie`, `Authorization`, or `Proxy-Authorization`
headers bypass the shared response cache, whether or not cookies are forwarded.
Site SEO snapshot hashing and authoritative origin variation are automatic;
`vary` is only for additional non-SEO public dimensions.

---

# Advanced: Custom Extensions

Most applications do not need extensions.

Use `defineExtension()` only for custom request/app-scoped runtime behavior:

```ts
import { defineExtension } from 'vue-ssr-lite'

const analytics = defineExtension({
  name: 'analytics',

  createState() {
    return {
      enabled: true,
    }
  },

  setup(context) {
    context.contributeHead({
      meta: [
        {
          name: 'x-analytics',
          content: 'enabled',
        },
      ],
    })
  },
})
```

Register it:

```ts
export default defineApplication({
  root: App,
  routes,

  extensions: [analytics],
})
```

Built-in features such as SEO are already installed automatically.

---

# Advanced: Vite Plugin Options

Normal usage:

```ts
vueSsrLite()
```

Advanced:

```ts
vueSsrLite({
  config: './ssr.config.ts',
  root: process.cwd(),
  dedupe: ['some-package'],
  ssrNoExternal: ['some-library'],
})
```

| Option          | Description                      |
| --------------- | -------------------------------- |
| `config`        | Custom SSR config path           |
| `root`          | Project root                     |
| `dedupe`        | Extra packages to deduplicate    |
| `ssrNoExternal` | Packages bundled into SSR output |

---

# Common Problems

## Node APIs used in Vue code

Move Node-only work from `src/**` into server-only files.

## Stateful Vue plugin shared between requests

Prefer:

```ts
plugins: () => [createPinia()]
```

## Missing production canonical origin

Set:

```bash
PUBLIC_URL=https://example.com
```

or configure `seo.siteUrl`.

## Wrong host/protocol behind a proxy

Use:

```ts
server: {
  trustProxy: true,
}
```

only behind a trusted reverse proxy.

## Dynamic route missing from sitemap

Add dynamic URLs through `sitemap.config.ts` and `defineSitemap()`.

---

# License

MIT
