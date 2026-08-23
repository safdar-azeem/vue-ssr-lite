# vue-ssr-lite Architecture Refactor Plan

> **Architectural Principle:**  
> **Hosted applications declare intent. `vue-ssr-lite` handles SSR/SEO infrastructure.**  
> **Automate mechanics. Default safe conventions. Declare business meaning.**

---

## 1. Target Architecture & Overview

```text
                        HOSTED VUE APPLICATION
                     (Builto Landing / future apps)
                                 │
                     ┌───────────┴───────────┐
                     │                       │
           Universal main.ts               Pages / Components
                     │                       │
           defineApplication()          useSeo(...) [Reactive & Scoped]
                     │                       │
                     └───────────┬───────────┘
                                 │
                                 ▼
                        ┌────────────────┐
                        │  vue-ssr-lite  │
                        │  (Standalone)  │
                        │                │
                        │ Universal App  │
                        │ Router Engine  │
                        │ SSR Lifecycle  │
                        │ Hydration Sync │
                        │ SEO Store      │
                        │ Head Reconciler│
                        │ Canonical URLs │
                        │ Static Sitemap │
                        │ robots.txt     │
                        │ HTTP Statuses  │
                        │ Origin Resolver│
                        │ publicConfig   │
                        │ JSON-LD Engine │
                        │ Server Runtime │
                        └───────┬────────┘
                                │
                      optional integration
                                │
                                ▼
                          ┌───────────┐
                          │  vlite3   │
                          │ (UI / SPA)│
                          └───────────┘
```

### Core Architecture Invariants

1. **Standalone Core**: `vue-ssr-lite` owns the full SSR, hydration, and SEO lifecycle. It has **no dependency** on `vlite3` or any external UI library.
2. **No Third SEO Package**: SEO primitives live directly in `vue-ssr-lite`. `@vue-ssr-lite/seo-core` is rejected for architectural minimalism.
3. **No `<SeoProvider>` Required**: Developers call `useSeo()` directly in components, pages, or layouts. Scoped SEO state is managed automatically per component and request.
4. **Universal API with Reactive Scoping**: `useSeo()` works identically during SSR (waiting for async page settling) and browser navigation (with automatic component-unmount cleanup).
5. **Safe Canonical & Origin Resolution**: Production canonical URLs resolve authoritatively from `process.env.PUBLIC_URL`, `defineApplication({ seo: { siteUrl } })`, or server configuration. Raw `Host` headers are never trusted in production.
6. **Strict Server-Only Boundaries**:
   - `src/main.ts` is universal: developers **never** write `process.env` in `main.ts`.
   - Dynamic sitemap queries (databases, private APIs) live in server-only modules (`src/sitemap.ts` or `defineSsrConfig`).
7. **Generic Route Metadata**: `vue-ssr-lite` understands only its own namespaces (`meta.seo` and `meta.ssr`), with built-in TypeScript definitions.
8. **Breaking Cleanup Allowed**: No legacy SSR bridges or temporary dual-layer adapters are carried forward. Clean, unified contracts only.

---

## 2. Progressive API Hierarchy

The public API is organized into three distinct levels of disclosure:

```text
LEVEL 1 — Normal Application Developer (90% of use cases)
├── defineApplication()
└── useSeo()

LEVEL 2 — Applications Requiring Server-to-Client Configuration
└── usePublicConfig<T>()

LEVEL 3 — Server & Platform Infrastructure Developer (Server-Only)
├── defineSsrConfig()
├── defineSitemap()
├── useSsrRequestContext()
├── setResponseStatus()
└── Custom server endpoints & hooks
```

---

## 3. Hosted Application Structure & Universal Boundaries

A hosted application using `vue-ssr-lite` is a completely standard Vue 3 project with a clear boundary between universal app code and optional server extensions:

```text
builto-landing/
│
├── index.html
├── vite.config.ts
│
├── src/
│   ├── main.ts            <── Pure universal app definition (no process.env)
│   ├── App.vue
│   ├── routes.ts
│   │
│   ├── pages/
│   │   ├── Home.vue
│   │   ├── About.vue
│   │   ├── Pricing.vue
│   │   └── NotFound.vue
│   │
│   └── sitemap.ts         <── (Optional) Server-only dynamic sitemap provider
│
└── ssr.config.ts          <── (Optional) Server-only infrastructure overrides
```

### Eliminated Application Plumbing

Hosted applications **no longer maintain**:

```text
DELETE:
├── entry-client.ts
├── entry-server.ts
├── hydrate.ts
├── server.ts
├── src/LandingSsrContext.ts
├── src/modules/Public/seo/PublicSsrSeo.ts
├── src/modules/Public/utils/PublicSiteOrigin.ts
├── src/server/LandingSeoEndpoints.ts
└── src/config/LandingPublicRuntime.ts
```

---

## 4. Universal Application Setup (`main.ts`)

`src/main.ts` is imported in both client and SSR bundles. It contains **no server-only code and no `process.env` references**.

### Standard `src/main.ts`

```ts
import { defineApplication } from 'vue-ssr-lite'
import App from './App.vue'
import { routes } from './routes'
import { createVLite } from 'vlite3'

export default defineApplication({
  root: App,
  routes,
  plugins: [createVLite()],

  seo: {
    siteName: 'Builto',

    title: {
      default: 'Builto',
      template: '%s | Builto',
    },

    description:
      'Create websites, documents, and organize your workspace.',

    image: '/assets/brand/social-card.png',
  },
})
```

> **Server Resolution of `PUBLIC_URL`**: `vue-ssr-lite` automatically inspects `process.env.PUBLIC_URL` within the **server runtime**. The hosted application does not need to wire environment variables into `main.ts`.

---

## 5. Universal `useSeo()`: Lifecycle, Scoping & Reactivity

### 5.1 Scoped Contribution System

`useSeo()` is not a flat global object; it is a **scoped contribution system** with component-level ownership and deterministic hierarchy:

```text
APPLICATION DEFAULTS (defineApplication.seo)
            ↓
ROUTE METADATA (route.meta.seo)
            ↓
LAYOUT CONTRIBUTIONS (useSeo in App/Layout)
            ↓
PAGE CONTRIBUTIONS (useSeo in active Page)
            ↓
NESTED COMPONENT CONTRIBUTIONS (useSeo in Child Component)
            ↓
FINAL NORMALIZED SEO SNAPSHOT
```

#### Lifecycle & Cleanup Rules:

1. **Component Ownership**: Each `useSeo()` call is bound to the active Vue component instance via `getCurrentInstance()`.
2. **Automatic Cleanup on Unmount**: When a child component or modal unmounts (`onUnmounted`), its SEO contributions are automatically removed, restoring the parent page/layout values.
3. **Route Navigation Cleanup**: When navigating from Page A to Page B, Page A's contributions are discarded entirely. Page A's properties (e.g. `image: 'a.png'`) will **never leak** into Page B.
4. **Deterministic Merge Order**: Later mounted child components override ancestor properties for identical keys (e.g., child `title` overrides layout `title`).

### 5.2 Reactivity & Async Data Settling

`useSeo()` accepts reactive inputs and automatically coordinates with the SSR async data-settling lifecycle:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { useSeo } from 'vue-ssr-lite'

const props = defineProps<{ slug: string }>()
const { data: article } = await useAsyncData(`article-${props.slug}`, () => fetchArticle(props.slug))

// Reactive / Getter inputs:
useSeo({
  title: computed(() => article.value?.title || 'Article'),
  description: () => article.value?.excerpt,
  image: () => article.value?.coverImage,
  canonical: `/blog/${props.slug}`,
})
</script>
```

#### Timing Invariant:
- During SSR, `vue-ssr-lite` captures the final SEO snapshot **only after** all asynchronous page setup, `Suspense`, and data-settling promises have completed.
- SSR never serializes intermediate or `undefined` SEO values while async data is in flight.

### 5.3 Zero-Duplication Property Propagation

Developers do not need to manually repeat metadata for Open Graph and Twitter cards:

```ts
useSeo({
  title: 'About',
  description: 'Learn about us.',
  image: '/social/about.png',
})
```

`vue-ssr-lite` automatically propagates:
- `<title>About | Builto</title>`
- `<meta name="description" content="Learn about us.">`
- `<link rel="canonical" href="https://builto.com/about">`
- `<meta property="og:title" content="About | Builto">`
- `<meta property="og:description" content="Learn about us.">`
- `<meta property="og:image" content="https://builto.com/social/about.png">`
- `<meta name="twitter:title" content="About | Builto">`
- `<meta name="twitter:description" content="Learn about us.">`
- `<meta name="twitter:image" content="https://builto.com/social/about.png">`
- `<meta name="twitter:card" content="summary_large_image">`

---

## 6. Deterministic Head Ownership & Hydration Reconciliation

To prevent duplicate tags and avoid conflicts with consumer-owned elements in `index.html`, `vue-ssr-lite` establishes explicit tag identity and ownership.

### Managed Tag Keys

| Tag | Deterministic Identity / Selector | Behavior |
|---|---|---|
| `<title>` | `title` | Replaces `document.title` on client; replaces `<title>` on SSR |
| Canonical URL | `link[rel="canonical"]` | Reconciled/updated on navigation |
| Standard Meta | `meta[name="<key>"]` (e.g. `description`, `robots`, `twitter:*`) | Reconciled by `name` |
| Open Graph Meta | `meta[property="<key>"]` (e.g. `og:title`, `og:image`) | Reconciled by `property` |
| JSON-LD Scripts | `script[type="application/ld+json"][data-v-ssr-seo]` | Tagged with `data-v-ssr-seo` attribute; fully managed |

### Hydration & Navigation Reconciliation Algorithm

1. **SSR Generation**: Renders all managed tags into `<head>`, tagging JSON-LD scripts with `data-v-ssr-seo="true"`.
2. **Client Hydration**: Reads SSR head state; attaches to existing managed tags without recreating DOM nodes.
3. **Client Navigation**: Computes the diff between previous and next normalized SEO state. Updates, adds, or removes managed tags accordingly.
4. **Unmanaged Element Safety**: Elements declared in `index.html` (favicons, external CSS, font links, custom third-party scripts) without `vue-ssr-lite` ownership keys are **never modified or removed**.

---

## 7. Safe Public Origin, Canonical URLs & Failure Contracts

### 7.1 Authoritative Origin Resolution Priority

Origin resolution is computed **per application instance**:

```text
PRODUCTION RESOLUTION PRIORITY:
1. defineApplication({ seo: { siteUrl: 'https://builto.com' } })
2. process.env.PUBLIC_URL (read by SSR runtime)
3. Server-side custom domain resolver hook in defineSsrConfig
4. FATAL STARTUP / REQUEST ERROR (Fail-Fast)

DEVELOPMENT RESOLUTION:
1. Explicit siteUrl / PUBLIC_URL (if provided)
2. Current local dev server origin (http://localhost:<port>)
```

### 7.2 Strict Production Failure Contract

If an absolute URL is required for canonical links, Open Graph tags, sitemaps, or JSON-LD in production, and no authoritative origin can be resolved:

> **Production Invariant**: `vue-ssr-lite` **fails immediately** with an explicit, actionable error message:  
> `[vue-ssr-lite] Production siteUrl is missing. Set process.env.PUBLIC_URL or defineApplication({ seo: { siteUrl } }) to generate authoritative canonical SEO URLs.`  
> The library **never** silently falls back to `localhost`, internal proxy hosts, or empty strings in production.

### 7.3 Canonical Path Normalization Policy

The library applies deterministic URL normalization:

- **Query Parameters**: Stripped by default (e.g. `/about?utm_source=x` becomes `https://builto.com/about`).
- **Hash Fragments**: Stripped by default (e.g. `/about#team` becomes `https://builto.com/about`).
- **Trailing Slash Policy**: Normalized to no trailing slash by default (`/about/` becomes `/about`), except root `/`. Configurable via `seo.trailingSlash`.
- **Absolute Overrides**: If `canonical` begins with `http://` or `https://`, it is used directly without origin expansion.

---

## 8. Route Metadata (`meta.seo` & `meta.ssr`) & TypeScript Typings

### 8.1 First-Class TypeScript Augmentation

`vue-ssr-lite` provides automatic module augmentation for `vue-router`'s `RouteMeta`:

```ts
// Built into vue-ssr-lite:
declare module 'vue-router' {
  interface RouteMeta {
    seo?: {
      title?: string
      description?: string
      image?: string
      index?: boolean
      follow?: boolean
      sitemap?: boolean
    }
    ssr?: {
      status?: number
    }
  }
}
```

### 8.2 Route Definition Example

```ts
import { RouteRecordRaw } from 'vue-router'
import Home from './pages/Home.vue'
import About from './pages/About.vue'
import Dashboard from './pages/Dashboard.vue'
import NotFound from './pages/NotFound.vue'

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: Home,
  },
  {
    path: '/about',
    component: About,
  },
  {
    path: '/dashboard',
    component: Dashboard,
    meta: {
      seo: {
        index: false, // Application sets indexing; vue-ssr-lite handles SEO & sitemap exclusion
      },
    },
  },
  {
    path: '/:pathMatch(.*)*',
    component: NotFound,
    meta: {
      ssr: {
        status: 404, // 4xx/5xx automatically defaults seo.index to false!
      },
    },
  },
]
```

### 8.3 Safe HTTP 4xx/5xx Defaults

- Setting `meta.ssr.status = 404` (or calling `setResponseStatus(404)`) automatically implies `meta.seo.index = false` (`noindex`).
- Developers do not need to duplicate `seo: { index: false }` on error/not-found routes unless overriding explicitly.

---

## 9. Sitemap Generation (`/sitemap.xml`)

### 9.1 Division of Responsibility

| Responsibility | Owner | Execution Boundary |
|---|:---:|:---:|
| `/sitemap.xml` HTTP endpoint & routing | **vue-ssr-lite** | Server |
| Static route discovery & URL resolution | **vue-ssr-lite** | Server |
| XML formatting, entity escaping & headers | **vue-ssr-lite** | Server |
| Filtering non-indexable routes (`meta.seo.index === false`) | **vue-ssr-lite** | Server |
| Dynamic entity discovery (e.g. database blog slugs) | **Application** | **Server-Only** |

### 9.2 Deterministic Static Route Discovery Rules

`vue-ssr-lite` inspects the Vue Router tree during server startup:

#### INCLUDED in Static Sitemap:
- Concrete, navigable static routes (e.g. `/`, `/about`, `/pricing`).
- Nested concrete static routes after full path concatenation (e.g. `/docs/getting-started`).

#### EXCLUDED from Static Sitemap:
- Redirect records (`redirect: ...`).
- Route aliases (to prevent duplicate indexing).
- Catch-all / wildcard routes (e.g. `/:pathMatch(.*)*`).
- Unresolved dynamic routes (e.g. `/blog/:slug`, `/user/:id`).
- Routes with `meta.seo.index === false`.
- Routes with explicit `meta.seo.sitemap === false`.

> **Runtime SEO Note**: Page-level `useSeo({ robots: { index: false } })` cannot be known without rendering every dynamic page at build/request time. Sitemap inclusion relies strictly on the static route contract (`meta.seo`) or the dynamic sitemap provider.

### 9.3 Server-Only Dynamic Sitemap Extension

For dynamic content, the application provides an optional server-only sitemap module (`src/sitemap.ts`):

```ts
// src/sitemap.ts (SERVER-ONLY — Never bundled into client!)
import { defineSitemap } from 'vue-ssr-lite/server'
import { db } from './server/db'

export default defineSitemap(async () => {
  const articles = await db.article.findMany({ select: { slug: true, updatedAt: true } })

  return articles.map(article => ({
    loc: `/blog/${article.slug}`,
    lastmod: article.updatedAt.toISOString(),
    changefreq: 'weekly',
    priority: 0.8,
  }))
})
```

### 9.4 Caching & Collision Policies

- **Caching**: `/sitemap.xml` is served with default HTTP cache headers (`Cache-Control: public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400`).
- **Collision Detection**: If a project contains a physical `public/sitemap.xml` file, `vue-ssr-lite` warns and yields to the static file unless explicitly configured.

---

## 10. `robots.txt` Endpoint (`/robots.txt`)

### 10.1 Default Generation

`vue-ssr-lite` automatically serves `/robots.txt`:

```text
User-agent: *
Allow: /

Sitemap: https://builto.com/sitemap.xml
```

### 10.2 Principles & Configuration

- `robots.txt` is **not** an authorization system.
- `vue-ssr-lite` **never** scrapes private routes to publish disallow lists.
- Private routes are protected via authentication and `meta.seo.index: false` (`noindex`).
- Applications configure explicit disallow rules via `defineApplication`:

```ts
export default defineApplication({
  root: App,
  routes,
  seo: {
    robots: {
      disallow: ['/internal-preview/'],
    },
  },
})
```

---

## 11. Structured Data (JSON-LD)

- **Application Responsibility**: Declares schema content and domain meaning.
- **Library Responsibility**: Structural validation (object/array verification), JSON-LD serialization, character escaping, script injection, and DOM synchronization.

### Script Breakout Prevention

JSON-LD strings are sanitized against script injection:
- `</script>` tags within JSON data are escaped to `\u003C/script\u003E`.

```ts
useSeo({
  title: 'Builto Workspace',
  structuredData: [
    {
      '@type': 'SoftwareApplication',
      name: 'Builto',
      applicationCategory: 'Productivity',
      offers: {
        '@type': 'Offer',
        price: '0',
      },
    },
  ],
})
```

---

## 12. Multi-Application & Custom-Domain Support

`vue-ssr-lite` supports multi-tenant and multi-app deployments without global state contamination:

1. **Request & Application Isolation**: SEO state, canonical origin, and sitemaps are scoped strictly per application runtime and per incoming request. No global mutable variables (`currentSeo`, `siteUrl`).
2. **Custom-Domain Origin Resolver**: Platforms hosting dynamic user domains configure an origin resolver in `ssr.config.ts`:

```ts
import { defineSsrConfig } from 'vue-ssr-lite'

export default defineSsrConfig({
  resolveSiteUrl: async (req) => {
    const host = req.headers['host']
    const tenant = await lookupTenantByHost(host)
    return tenant ? `https://${tenant.customDomain}` : 'https://builto.com'
  },
})
```

---

## 13. Runtime Configuration Transport (`usePublicConfig<T>`)

Safe server-to-client configuration transport without ad-hoc application wrappers:

### In `ssr.config.ts` (Server Configuration)

```ts
import { defineSsrConfig } from 'vue-ssr-lite'

export default defineSsrConfig({
  publicConfig: () => ({
    apiUrl: process.env.PUBLIC_API_URL || 'https://api.builto.com',
    environment: process.env.NODE_ENV,
  }),
})
```

### In Application Components (Universal)

```vue
<script setup lang="ts">
import { usePublicConfig } from 'vue-ssr-lite'

interface AppConfig {
  apiUrl: string
  environment: string
}

const config = usePublicConfig<AppConfig>()
</script>
```

---

## 14. Coexistence with `vlite3`

- **For `vue-ssr-lite` Applications**:  
  Developers use `import { useSeo } from 'vue-ssr-lite'`. `vue-ssr-lite` is the sole authoritative head manager. No `vlite3` `<SeoProvider>` is mounted or used.
- **For Standalone SPA `vlite3` Applications**:  
  `vlite3` retains its existing SPA SEO system.
- **No Competing Head Managers**: If both packages are installed, `vue-ssr-lite` takes precedence in SSR runtime; no secondary head manager is initialized.

---

## 15. Complete Responsibility Matrix

| Capability | `vue-ssr-lite` | Hosted Application | `vlite3` |
|---|:---:|:---:|:---:|
| `createSSRApp()` / `createApp()` lifecycle | **OWNS** | — | — |
| Request isolation & context management | **OWNS** | — | — |
| `renderToString()` & hydration execution | **OWNS** | — | — |
| Scoped & reactive SEO store | **OWNS** | — | — |
| `useSeo()` implementation | **OWNS** | — | Optional consumer |
| Head reconciliation & deduplication | **OWNS** | — | — |
| Canonical URL assembly & path normalization | **OWNS** | — | — |
| Authoritative origin resolution (`PUBLIC_URL` / `siteUrl`) | **OWNS** | — | — |
| Static route discovery for sitemap | **OWNS** | — | — |
| Dynamic sitemap execution & endpoint | **OWNS** | **OWNS** (Data Provider) | — |
| `/robots.txt` endpoint & standard formatting | **OWNS** | — | — |
| HTTP response status codes & 404 defaults | **OWNS** | — | — |
| `usePublicConfig<T>()` transport & serialization | **OWNS** | — | — |
| JSON-LD structural validation, escaping & insertion | **OWNS** | — | — |
| Structured data business schema content | — | **OWNS** | Optional schema helpers |
| Page titles, descriptions, social images | — | **OWNS** | — |
| Global site branding & default SEO | — | **OWNS** | — |
| UI Component library | — | — | **OWNS** |

---

## 16. Phased Implementation Plan

```text
PHASE 1: Core SEO Types & Request/Client SEO Store
├── Define universal SEO interfaces (Title, Meta, OpenGraph, Twitter, StructuredData, Robots)
├── Implement request-scoped SEO store for SSR
└── Implement reactive client-scoped SEO store

PHASE 2: useSeo() Lifecycle, Reactivity & Scoped Cleanup
├── Implement useSeo() composable bound to getCurrentInstance()
├── Implement automatic onUnmounted() contribution removal
├── Add support for Ref, ComputedRef, and getter inputs
└── Integrate with SSR async data settling (Suspense / async setup)

PHASE 3: SSR Head Finalization & Client Head Reconciliation
├── Implement SSR head tag serializer with data-v-ssr-seo identity markers
├── Implement browser DOM head reconciler with deterministic diffing
└── Add JSON-LD script breakout protection (\u003C/script\u003E)

PHASE 4: Authoritative Origin Resolution & Canonical Path Normalization
├── Implement server-side siteUrl resolution (process.env.PUBLIC_URL fallback)
├── Implement production fail-fast validator for missing siteUrl
└── Implement canonical path normalizer (strip queries/hashes, trailing slash policy)

PHASE 5: Route Metadata Contracts (meta.seo, meta.ssr) & HTTP Statuses
├── Add TypeScript module augmentation for vue-router RouteMeta
├── Implement status code handler (setResponseStatus and meta.ssr.status)
└── Connect HTTP 4xx/5xx statuses to automatic noindex defaults

PHASE 6: Static Sitemap & Robots.txt Infrastructure
├── Implement static route discovery engine from Vue Router tree
├── Implement XML sitemap serializer, caching headers & collision checks
└── Implement /robots.txt endpoint with standard defaults and custom disallow rules

PHASE 7: Server-Only Dynamic Sitemap Extension
├── Implement defineSitemap helper in vue-ssr-lite/server
└── Connect dynamic sitemap provider to /sitemap.xml endpoint

PHASE 8: usePublicConfig<T>() Transport Cleanup
├── Implement server-to-client configuration serializer
└── Expose universal usePublicConfig<T>() composable

PHASE 9: vlite3 Coexistence & Package Independence
├── Verify clean separation: vue-ssr-lite has zero vlite3 dependencies
└── Ensure single authoritative head manager when vlite3 components are imported

PHASE 10: Builto Landing Migration & Cleanup
├── Update Builto Landing to use new defineApplication() and useSeo()
└── Delete legacy files (LandingSsrContext, PublicSsrSeo, PublicSiteOrigin, etc.)

PHASE 11: Comprehensive Test Suite & Production Verification
└── Execute full verification test matrix across SSR, Client, Sitemap, and Security
```

---

## 17. Validation & Verification Test Matrix

| Area | Test Scenario | Expected Outcome |
|---|---|---|
| **SSR** | Concurrent requests with different routes | Request A and Request B do not leak or share SEO state |
| **SSR** | Asynchronous page data resolution | Final `<head>` contains resolved title, not `undefined` |
| **SSR** | HTTP 404 Not Found route | Response status is 404; `<meta name="robots" content="noindex, follow">` present |
| **SSR** | Production canonical resolution | Emits authoritative canonical URL matching `PUBLIC_URL` / `siteUrl` |
| **SSR** | Production missing `siteUrl` | Fails fast with clear actionable error; never emits `localhost` |
| **Client** | Route navigation (Page A ➔ Page B) | Page A's SEO is discarded; Page B's SEO applied to DOM |
| **Client** | Component unmount (Modal with `useSeo`) | Unmounting modal restores underlying page SEO state |
| **Client** | Hydration tag reconciliation | Reconciles existing SSR tags; zero duplicate `<meta>`/`<link>` tags created |
| **Client** | Browser Back/Forward navigation | SEO state accurately reflects active history state |
| **Sitemap** | Static nested routes | Concatenated paths (`/docs/intro`) included in sitemap |
| **Sitemap** | Route exclusions | Redirects, aliases, catch-alls, and `meta.seo.index: false` excluded |
| **Sitemap** | Server-only dynamic entries | `src/sitemap.ts` dynamic URLs merged into `/sitemap.xml` |
| **Robots** | `/robots.txt` endpoint | Returns valid `robots.txt` referencing `/sitemap.xml` |
| **Security** | Spoofed `Host` header | Request canonical URL remains authoritative; does not reflect spoofed host |
| **Security** | JSON-LD script breakout | `</script>` tags in JSON-LD escaped to `\u003C/script\u003E` |
| **Multi-App** | Multi-tenant isolation | App A and App B maintain completely isolated origins and sitemaps |
| **Production**| Full build & start (`builto-landing`) | Production build runs with zero SSR glue code |

---

## 18. Builto Landing Target End-State & Acceptance Criteria

### Acceptance Criteria Checklist

- [ ] `src/LandingSsrContext.ts` is deleted.
- [ ] `src/modules/Public/seo/PublicSsrSeo.ts` is deleted.
- [ ] `src/modules/Public/utils/PublicSiteOrigin.ts` is deleted.
- [ ] `src/server/LandingSeoEndpoints.ts` is deleted.
- [ ] `src/config/LandingPublicRuntime.ts` is deleted (or reduced to non-SSR app constants).
- [ ] `App.vue` contains no `<SeoProvider>` or custom head resolver.
- [ ] `src/main.ts` contains only `defineApplication({ root: App, routes, seo: { siteName: 'Builto' } })`.
- [ ] Pages use only `import { useSeo } from 'vue-ssr-lite'`.
- [ ] SSR HTML, hydration, `/sitemap.xml`, and `/robots.txt` function out of the box.
