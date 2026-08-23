# vue-ssr-lite Architecture Refactor Plan

> **Architectural Principle:**  
> **Hosted applications declare intent. `vue-ssr-lite` handles SSR/SEO infrastructure.**  
> **Simple outside. Small inside. Powerful when needed.**  
> **Automate the common 95% safely. Provide lean escape hatches for the remaining 5%.**

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
           defineApplication()             useSeo(...)
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
                        │ SEO State      │
                        │ Head Reconcile │
                        │ Canonical URLs │
                        │ Static Sitemap │
                        │ robots.txt     │
                        │ HTTP Statuses  │
                        │ Origin Resolver│
                        │ publicConfig   │
                        │ JSON-LD Sync   │
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
4. **Synchronous `useSeo()` Registration**: `useSeo()` registers its contributions **synchronously during component `setup()`**, ensuring full availability during SSR before rendering HTML.
5. **Universal API with Reactive Scoping**: Works seamlessly during SSR (participating in the existing async settling lifecycle) and browser navigation (with batched head reconciliation and `<KeepAlive>` support).
6. **Safe Canonical & Origin Resolution**: Production canonical URLs resolve authoritatively from `process.env.PUBLIC_URL`, `defineApplication({ seo: { siteUrl } })`, or server configuration. Raw `Host` headers are never trusted in production.
7. **Strict Server-Only Boundaries**:
   - `src/main.ts` is strictly universal: developers **never** write `process.env` in `main.ts`.
   - Dynamic sitemap queries (databases, private APIs) live in the server-only `sitemap.config.ts` module.
8. **Unified SEO Contract (`SeoInput` & `UseSeoInput`)**: Application defaults, route metadata, and page composables share **one consistent SEO vocabulary**, with explicit typing for reactive inputs in `useSeo()`.
9. **Technical SEO Scope**: `vue-ssr-lite` guarantees technical correctness and search engine crawlability (HTML tags, status codes, canonicals, sitemaps, robots). It does not attempt content ranking, keyword density analysis, or search-console automation.
10. **Breaking Cleanup Allowed**: No legacy SSR bridges or temporary dual-layer adapters are carried forward. Clean, unified contracts only.

---

## 2. Developer Personas & Progressive API Hierarchy

The architecture is designed to support four distinct developer personas with progressive disclosure of complexity:

```text
PERSONA A — JUNIOR / FIRST SSR PROJECT (Zero SSR knowledge required)
├── defineApplication({ root: App, routes })
└── useSeo({ title, description })
└── Local: Zero config (http://localhost:<port>)
└── Deployment: PUBLIC_URL=https://example.com

PERSONA B — NORMAL MID-LEVEL APPLICATION DEVELOPER
├── defineApplication({ seo: { siteName, title, titleTemplate, image } })
└── Route metadata: meta.seo, meta.ssr

PERSONA C — SENIOR APPLICATION DEVELOPER
├── usePublicConfig<T>()
├── sitemap.config.ts (Dynamic sitemap data provider)
├── Structured data (JSON-LD)
├── Advanced head extensibility (meta[], links[])
├── Custom canonical overrides & trailing slash policies
└── Private/internal app mode: defineApplication({ seo: { mode: 'private' } })

PERSONA D — PLATFORM & INFRASTRUCTURE ENGINEER
├── ssr.config.ts (defineSsrConfig: publicConfig, resolveSiteUrl, trustProxy)
├── useSsrRequestContext()
├── setResponseStatus()
└── Custom server middleware, hooks & caching overrides
```

### Public API Surface

| Category | Exports | File Boundary |
|---|---|---|
| **Normal (Level 1)** | `defineApplication`, `useSeo` | Universal (`src/`) |
| **Advanced Application (Level 2)** | `usePublicConfig`, `setResponseStatus` | Universal (`src/`) |
| **Server Configuration (Level 3)** | `defineSsrConfig`, `defineSitemap`, `useSsrRequestContext` | Server-Only (`*.config.ts`, `server/`) |

### Layered Documentation Structure

1. **Getting Started / Quickstart**: Persona A (Install, Vite plugin, `defineApplication`, `useSeo`, `PUBLIC_URL` deployment).
2. **SEO & Routing Guide**: Persona B (Site-wide defaults, `meta.seo`, `meta.ssr`, 404 handling, private mode).
3. **Advanced Application Features**: Persona C (`sitemap.config.ts`, `usePublicConfig`, structured data, `meta[]`/`links[]`).
4. **Server & Platform Architecture**: Persona D (`ssr.config.ts`, custom domain resolvers, request isolation, server hooks).

---

## 3. Hosted Application Structure & Server Boundaries

A hosted application using `vue-ssr-lite` maintains a clean separation between universal application source code and optional server extensions:

```text
builto-landing/
│
├── index.html
├── vite.config.ts
│
├── src/
│   ├── main.ts            <── Pure universal application entry (no process.env)
│   ├── App.vue
│   ├── routes.ts
│   │
│   └── pages/
│       ├── Home.vue
│       ├── About.vue
│       ├── Pricing.vue
│       └── NotFound.vue
│
├── sitemap.config.ts      <── (Optional) Server-only dynamic sitemap provider
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

### Step 1: Minimal Experience (Persona A — Beginner)

```ts
import { defineApplication } from 'vue-ssr-lite'
import App from './App.vue'
import { routes } from './routes'

export default defineApplication({
  root: App,
  routes,
})
```

### Step 2: Adding Global SEO Defaults (Persona B — Mid-Level)

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
    title: 'Builto',
    titleTemplate: '%s | Builto',
    description: 'Create websites, documents, and organize your workspace.',
    image: '/assets/brand/social-card.png',
  },
})
```

### Step 3: Private / Internal Applications Mode (Persona C)

If an application is an internal dashboard, private portal, or behind authentication:

```ts
export default defineApplication({
  root: App,
  routes,
  seo: {
    mode: 'private', // Single canonical syntax for private applications
    title: 'Builto Dashboard',
    titleTemplate: '%s | Builto Workspace',
  },
})
```

#### Private Mode Semantics:
- **What continues to work**: `useSeo()` `title`, `description`, custom `meta`, `links`, and client `document.title` + SSR `<title>` tags function normally for application usability.
- **What is disabled**: No canonical URL generation, no `/sitemap.xml` endpoint, no `/robots.txt` endpoint, no `PUBLIC_URL` deployment requirement, and default emission of `<meta name="robots" content="noindex, nofollow">`.

---

## 5. Unified Public SEO Schemas & TypeScript Contracts

To eliminate cognitive friction, **Application SEO, Route SEO, and Page SEO share the exact same core schema**, with dedicated typing for composable reactivity.

### Core Type Definitions

```ts
import type { Ref, ComputedRef } from 'vue'

/** Reactive or plain value wrapper */
export type SeoResolvable<T> = T | Ref<T> | ComputedRef<T> | (() => T)

/** Thin escape hatch for custom meta tags */
export interface SeoMetaEntry {
  key?: string
  name?: string
  property?: string
  httpEquiv?: string
  content: string
}

/** Thin escape hatch for custom link tags */
export interface SeoLinkEntry {
  key?: string
  rel: string
  href: string
  hreflang?: string
  type?: string
  media?: string
}

/** Core plain serializable SEO data contract */
export interface SeoInput {
  title?: string
  description?: string
  image?: string
  canonical?: string | false
  index?: boolean
  follow?: boolean
  openGraph?: {
    type?: string
    title?: string
    description?: string
    image?: string
    url?: string
  }
  twitter?: {
    card?: string
    title?: string
    description?: string
    image?: string
  }
  robots?: {
    maxSnippet?: number
    maxImagePreview?: 'none' | 'standard' | 'large'
    noarchive?: boolean
    nosnippet?: boolean
  }
  structuredData?: Record<string, any> | Array<Record<string, any>>
  meta?: SeoMetaEntry[]
  links?: SeoLinkEntry[]
}

/** Composable input schema supporting Vue reactivity */
export interface UseSeoInput {
  title?: SeoResolvable<string | undefined>
  description?: SeoResolvable<string | undefined>
  image?: SeoResolvable<string | undefined>
  canonical?: SeoResolvable<string | false | undefined>
  index?: SeoResolvable<boolean | undefined>
  follow?: SeoResolvable<boolean | undefined>
  openGraph?: SeoResolvable<SeoInput['openGraph']>
  twitter?: SeoResolvable<SeoInput['twitter']>
  robots?: SeoResolvable<SeoInput['robots']>
  structuredData?: SeoResolvable<SeoInput['structuredData']>
  meta?: SeoResolvable<SeoMetaEntry[] | undefined>
  links?: SeoResolvable<SeoLinkEntry[] | undefined>
}

/** Route-level metadata schema */
export interface SeoRouteInput extends SeoInput {
  sitemap?: boolean
}

/** Global application configuration schema */
export interface SeoApplicationConfig extends SeoInput {
  siteName?: string
  titleTemplate?: string
  siteUrl?: string
  trailingSlash?: boolean
  mode?: 'public' | 'private'
  robotsTxt?: {
    disallow?: string[]
    allow?: string[]
  }
}
```

### TypeScript Module Augmentation Built-In

```ts
// Built into vue-ssr-lite — autocomplete and validation work out of the box:
declare module 'vue-router' {
  interface RouteMeta {
    seo?: SeoRouteInput
    ssr?: {
      status?: number
    }
  }
}
```

---

## 6. Universal `useSeo()`: Scoping, Lifecycle & Reactivity

### 6.1 Standard Page Usage (Automatic Canonical & Social Tags)

In normal usage, canonical URLs, Open Graph tags, and Twitter cards are **completely automatic**:

```vue
<script setup lang="ts">
import { useSeo } from 'vue-ssr-lite'

useSeo({
  title: 'About',
  description: 'Learn more about Builto and our mission.',
})
</script>

<template>
  <main>
    <h1>About Builto</h1>
  </main>
</template>
```

#### Automatic Property Derivation:
- `<title>About | Builto</title>`
- `<meta name="description" content="Learn more about Builto and our mission.">`
- `<link rel="canonical" href="https://builto.com/about">` (automatically derived from active route)
- `<meta property="og:title" content="About | Builto">`
- `<meta property="og:description" content="Learn more about Builto and our mission.">`
- `<meta property="og:url" content="https://builto.com/about">`
- `<meta name="twitter:title" content="About | Builto">`
- `<meta name="twitter:description" content="Learn more about Builto and our mission.">`
- `<meta name="twitter:card" content="summary_large_image">`

### 6.2 Advanced Overrides & Custom Tags (Escape Hatch)

Senior developers can override specific properties or inject custom meta/link tags:

```ts
useSeo({
  title: 'Introducing Workspaces',
  canonical: '/blog/introducing-workspaces', // Path override
  // canonical: 'https://other-domain.com/article', // Cross-domain canonical
  // canonical: false, // Disables canonical link tag
  index: false, // Emits noindex
  openGraph: {
    type: 'article',
    title: 'Custom Social Title',
  },
  meta: [
    { name: 'author', content: 'Safdar' },
    { property: 'article:published_time', content: '2026-08-24T00:00:00Z' },
    { name: 'theme-color', content: '#0f172a' },
  ],
  links: [
    { rel: 'alternate', hreflang: 'ar', href: '/ar/about' },
    { rel: 'alternate', hreflang: 'en', href: '/en/about' },
  ],
})
```

### 6.3 Synchronous Registration & Internal Lifecycle

- **SSR**: `useSeo()` registers its contribution **synchronously during component `setup()`**. When the SSR request finishes rendering, the request scope is cleanly disposed.
- **Client**: `setup()` registers the contribution. When a component unmounts (`onUnmounted()`), its contribution is removed, restoring the parent/layout state.
- **`<KeepAlive>`**: Inactive components suspend their SEO contributions on `onDeactivated()` and restore them on `onActivated()`.
- **Precedence Hierarchy**: `APPLICATION < ROUTE < LAYOUT < PAGE < DESCENDANT COMPONENT`. (Developers simply call `useSeo()` in pages and optionally in layouts for defaults; the internal hierarchy manages resolution).

### 6.4 Reactivity & Participation in Existing SSR Settling

`useSeo()` accepts standard Vue reactive inputs (`Ref`, `ComputedRef`, or getter functions `() => T`):

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import { useSeo } from 'vue-ssr-lite'

const props = defineProps<{ slug: string }>()
const article = ref<{ title: string; excerpt: string } | null>(null)

// Plain Vue async setup:
article.value = await fetchArticle(props.slug)

useSeo({
  title: computed(() => article.value?.title || 'Article'),
  description: () => article.value?.excerpt,
})
</script>
```

> **SSR Lifecycle Invariant**: SEO does not create a separate settling engine. It reads the final state at the existing SSR settling point (after top-level async `setup` and `<Suspense>` resolution).

---

## 7. Head Tag Ownership Markers & Batched Reconciliation

### 7.1 Managed Ownership Attributes & Tag Identity

All tags generated by `vue-ssr-lite` are marked with `data-vue-ssr-lite-head`:

```html
<title data-vue-ssr-lite-head="title">About | Builto</title>
<meta name="description" content="..." data-vue-ssr-lite-head="description">
<link rel="canonical" href="..." data-vue-ssr-lite-head="canonical">
<meta property="og:title" content="..." data-vue-ssr-lite-head="og:title">
<meta name="twitter:card" content="..." data-vue-ssr-lite-head="twitter:card">
<script type="application/ld+json" data-vue-ssr-lite-head="json-ld">...</script>
```

### 7.2 Custom `meta[]` and `links[]` Identity Rules

- **Built-in Tags**: Identified by fixed library keys (`title`, `description`, `canonical`, `og:title`, etc.).
- **Custom Entries**:
  - If `key?: string` is provided, it serves as the explicit unique identity.
  - If `key` is omitted, identity is derived from primary attributes: `(name || property || httpEquiv) + ':' + content` for meta, and `rel + ':' + (hreflang || '') + ':' + (media || '') + ':' + href` for links.

### 7.3 Conflict Resolution with Pre-existing `index.html` Tags

- **Unrelated unmanaged tags** (favicons, font stylesheets, analytics scripts): **Never modified or deleted**.
- **Conflicting unmanaged SEO singleton tags** (e.g. static `<title>`, `<meta name="description">`, `<meta name="robots">`, `<link rel="canonical">` in `index.html`):
  - `vue-ssr-lite` managed SEO **supersedes** the static conflicting tag.
  - In development: emits a concise warning advising removal of the static duplicate.
  - In production: ensures exactly one authoritative tag exists in the DOM.

### 7.4 Batched Head Reconciliation on Navigation

On client-side route navigation (Page A ➔ Page B), the head reconciler calculates the final head snapshot and commits the DOM updates in a single batched pass. This prevents intermediate flashing of fallback/default titles or tags during page transitions.

---

## 8. Safe Public Origin & "One Deployment URL"

### 8.1 Resolution & Origin Normalization Invariant

- **Local Development**: Zero configuration required (automatically resolves `http://localhost:<port>`).
- **Production Deployment**: Set **one environment variable**: `PUBLIC_URL=https://builto.com`.

```text
PRODUCTION RESOLUTION PRIORITY:
1. defineApplication({ seo: { siteUrl: 'https://builto.com' } })
2. process.env.PUBLIC_URL (inspected by SSR runtime)
3. ssr.config.ts -> resolveSiteUrl (for custom domain platforms)
4. FAIL-FAST ERROR (Startup / Request validation)

DEVELOPMENT RESOLUTION:
1. Configured siteUrl / PUBLIC_URL (if provided)
2. Current local dev server origin (http://localhost:<port>)
```

#### Origin Normalization & Validation:
- `PUBLIC_URL` / `siteUrl` must be a valid origin: `http(s)://hostname[:port]`.
- Paths (e.g. `/foo`), query parameters (`?x=1`), and hashes (`#abc`) are rejected or stripped.
- Production requires `https://` unless explicitly configured for local/unusual environments.

### 8.2 Actionable Production Error Message

If an application with public SEO enabled is started in production without an authoritative origin, it fails immediately with a clear, concise diagnostic:

```text
[vue-ssr-lite] Missing PUBLIC_URL for production deployment.

Add:
PUBLIC_URL=https://example.com
```

### 8.3 Canonical Path Normalization

- **Query Parameters**: Stripped by default (`/about?utm_source=x` ➔ `https://builto.com/about`).
- **Hash Fragments**: Stripped by default (`/about#team` ➔ `https://builto.com/about`).
- **Trailing Slash Policy**: Normalized to no trailing slash by default (`/about/` ➔ `/about`), except root `/`. Configurable via `seo.trailingSlash`.

---

## 9. Route Metadata, HTTP 404 & Status Precedence

### 9.1 Route Definition

```ts
import { RouteRecordRaw } from 'vue-router'
import Home from './pages/Home.vue'
import Dashboard from './pages/Dashboard.vue'
import NotFound from './pages/NotFound.vue'

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: Home,
  },
  {
    path: '/dashboard',
    component: Dashboard,
    meta: {
      seo: {
        index: false, // Application sets indexing; sitemap exclusion is automatic
      },
    },
  },
  {
    path: '/:pathMatch(.*)*',
    component: NotFound,
    meta: {
      ssr: { status: 404 }, // Automatically defaults seo.index to false!
    },
  },
]
```

### 9.2 Safe 4xx/5xx Defaults & Precedence

- **Automatic Noindex**: Setting `meta.ssr.status = 404` (or calling `setResponseStatus(404)`) automatically implies `index: false` (`noindex`).
- **Status Precedence**: An effective HTTP 4xx/5xx status code overrides default page-level `index: true` settings, ensuring search engines never accidentally index error or not-found pages.

---

## 10. Sitemap Infrastructure (`/sitemap.xml`)

### 10.1 Static Route Discovery Rules

`vue-ssr-lite` discovers indexable routes by traversing Vue Router's resolved route records (correctly handling pathless parents `path: ''` and nested child routes):

#### INCLUDED in Static Sitemap:
- Concrete, navigable static routes (`/`, `/about`, `/pricing`).
- Resolved nested concrete static routes (`/docs/getting-started`).

#### EXCLUDED from Static Sitemap:
- Redirect records (`redirect: ...`).
- Route aliases (preventing duplicate indexing).
- Catch-all / wildcard routes (`/:pathMatch(.*)*`).
- Dynamic parameter routes (`/blog/:slug`, `/user/:id`).
- Routes with `meta.seo.index === false`.
- Routes with explicit `meta.seo.sitemap === false`.

### 10.2 Server-Only Dynamic Sitemap (`sitemap.config.ts`)

For dynamic content, applications provide an optional `sitemap.config.ts` at the project root. Simplified for Google SEO standards (omitting useless `priority` and `changefreq` fields):

```ts
// sitemap.config.ts (SERVER-ONLY — Never bundled into client!)
import { defineSitemap, type SitemapContext } from 'vue-ssr-lite/server'
import { db } from './server/db'

export default defineSitemap(async (context: SitemapContext) => {
  const articles = await db.article.findMany({ select: { slug: true, updatedAt: true } })

  return articles.map(article => ({
    loc: `/blog/${article.slug}`,
    lastmod: article.updatedAt,
  }))
})
```

#### Sitemap Types:
```ts
export interface SitemapEntry {
  loc: string
  lastmod?: string | Date
}

export interface SitemapContext {
  applicationId: string
  siteUrl: string
  request?: any
}
```

### 10.3 Deterministic File Collision Policy

- If a physical `public/sitemap.xml` exists, the physical static file wins and the dynamic generator is disabled.
- If a physical `public/robots.txt` exists, the physical static file wins and the dynamic generator is disabled.

---

## 11. `robots.txt` Endpoint (`/robots.txt`)

### 11.1 Default Output

`vue-ssr-lite` automatically serves `/robots.txt`:

```text
User-agent: *
Allow: /

Sitemap: https://builto.com/sitemap.xml
```

### 11.2 Custom Disallow Rules

```ts
export default defineApplication({
  root: App,
  routes,
  seo: {
    robotsTxt: {
      disallow: ['/internal-preview/'],
    },
  },
})
```

---

## 12. Structured Data Support (JSON-LD)

- **Application Responsibility**: Supplies schema content and domain meaning.
- **Library Responsibility**: Accepts JSON-compatible object(s), safely escapes script breakout (`</script>` ➔ `\u003C/script\u003E`), renders `<script type="application/ld+json">`, and updates on client navigation.

```ts
useSeo({
  title: 'Builto Workspace',
  structuredData: {
    '@type': 'SoftwareApplication',
    name: 'Builto',
    applicationCategory: 'Productivity',
  },
})
```

---

## 13. Runtime Configuration Transport & Security (`usePublicConfig<T>`) — Level 2

Safe server-to-client configuration transport without application context boilerplate:

### 13.1 Serialization Security Invariants

- `publicConfig` **must contain browser-safe data only**.
- `vue-ssr-lite` secures the serialized hydration payload:
  - Strings containing `</script>`, `<`, `>`, `&`, `\u2028`, and `\u2029` are safely escaped (e.g. `\u003C/script\u003E`).
  - Functions, symbols, cyclic references, and non-serializable objects are rejected with clear diagnostics.

### 13.2 Usage

In `ssr.config.ts` (Level 2 Server Configuration):

```ts
import { defineSsrConfig } from 'vue-ssr-lite'

export default defineSsrConfig({
  publicConfig: () => ({
    apiUrl: process.env.PUBLIC_API_URL || 'https://api.builto.com',
    environment: process.env.NODE_ENV,
  }),
})
```

In Application Components (Universal):

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

## 14. Platform Infrastructure (`ssr.config.ts`) — Level 3

For platform engineers needing custom server origin resolution or custom infrastructure:

```ts
import { defineSsrConfig } from 'vue-ssr-lite'

export default defineSsrConfig({
  server: {
    trustProxy: true,
    port: 3000,
  },
  resolveSiteUrl: async (req) => {
    const host = req.headers['host']
    const tenant = await lookupTenantByHost(host)
    return tenant ? `https://${tenant.customDomain}` : 'https://builto.com'
  },
})
```

---

## 15. Coexistence with `vlite3` (One App = One Head Manager)

- **`vue-ssr-lite` Applications**:  
  Developers use `import { useSeo } from 'vue-ssr-lite'`. `vue-ssr-lite` is the sole authoritative head manager. `<SeoProvider>` is removed.
- **Standalone SPA `vlite3` Applications**:  
  `vlite3` retains its own independent SPA SEO system.
- **No Competing Head Managers**: `vue-ssr-lite` does not execute complex runtime arbitration; applications use the native `vue-ssr-lite` import.

---

## 16. Complete Responsibility Matrix

| Capability | `vue-ssr-lite` | Hosted Application | `vlite3` |
|---|:---:|:---:|:---:|
| `createSSRApp()` / `createApp()` lifecycle | **OWNS** | — | — |
| Request isolation & context management | **OWNS** | — | — |
| `renderToString()` & hydration execution | **OWNS** | — | — |
| Synchronous & reactive SEO store | **OWNS** | — | — |
| `useSeo()` implementation | **OWNS** | — | Optional consumer |
| Batched head reconciliation & ownership markers | **OWNS** | — | — |
| Conflicting static head tag superseding | **OWNS** | — | — |
| Automatic canonical URL derivation | **OWNS** | — | — |
| Safe origin resolution (`PUBLIC_URL` / `siteUrl`) | **OWNS** | — | — |
| Static route discovery for sitemap | **OWNS** | — | — |
| Dynamic sitemap execution & endpoint | **OWNS** | **OWNS** (`sitemap.config.ts`) | — |
| `/robots.txt` endpoint & standard formatting | **OWNS** | — | — |
| HTTP response status codes & 404 defaults | **OWNS** | — | — |
| `usePublicConfig<T>()` transport & serialization security | **OWNS** | — | — |
| Structured data (JSON-LD) escaping & insertion | **OWNS** | — | — |
| Custom head tags escape hatch (`meta[]`, `links[]`) | **OWNS** | — | — |
| Structured data business schema content | — | **OWNS** | Optional schema helpers |
| Page titles, descriptions, social images | — | **OWNS** | — |
| Global site branding & default SEO | — | **OWNS** | — |
| UI Component library | — | — | **OWNS** |

---

## 17. Internal Module Structure

To prevent over-engineering, `vue-ssr-lite` organizes SEO and server capabilities in simple internal modules:

```text
src/
├── seo/
│   ├── types.ts          <── SeoInput, UseSeoInput, SeoApplicationConfig
│   ├── state.ts          <── Request-scoped and client SEO state store
│   ├── normalize.ts      <── SEO property derivation & social card propagation
│   ├── server.ts         <── SSR HTML <head> tag generation & JSON-LD escaping
│   └── client.ts         <── Batched browser DOM head reconciliation & KeepAlive
│
├── server/
│   ├── sitemap.ts        <── Static discovery, sitemap.config.ts runner, XML generator
│   ├── robots.ts         <── robots.txt endpoint handler
│   └── origin.ts         <── Safe PUBLIC_URL / siteUrl resolution & validation
│
└── runtime/              <── Existing SSR runtime, request context, publicConfig transport
```

---

## 18. Phased Implementation Plan

```text
PHASE 0: Public API & DX Contract Freeze
├── Freeze unified SeoInput, UseSeoInput, SeoRouteInput, and SeoApplicationConfig types
├── Freeze title as string everywhere and titleTemplate in SeoApplicationConfig
├── Freeze robots meta vs robotsTxt naming distinction
├── Freeze useSeo() synchronous setup() registration invariant
├── Freeze RouteMeta module augmentation
├── Freeze ownership marker format (data-vue-ssr-lite-head="<key>")
├── Freeze custom meta[]/links[] thin escape hatches
├── Freeze conflicting static tag superseding policy with dev warning
├── Freeze canonical private mode syntax (seo: { mode: 'private' })
├── Freeze SitemapContext and simplified SitemapEntry (loc, lastmod)
├── Freeze publicConfig serialization security rules
└── Freeze canonical dynamic sitemap file (sitemap.config.ts)

PHASE 1: Core SEO Types & State Store
├── Implement request-scoped SEO store for SSR
└── Implement reactive client-scoped SEO store with synchronous setup() registration

PHASE 2: useSeo() Composable & Reactivity
├── Implement useSeo() accepting UseSeoInput (Ref, ComputedRef, getters)
├── Implement onUnmounted() contribution cleanup
├── Implement onActivated() / onDeactivated() for <KeepAlive> support
└── Connect to existing SSR settling point (async setup / Suspense)

PHASE 3: SSR Head Rendering & Batched Browser Reconciliation
├── Implement SSR head tag serializer with data-vue-ssr-lite-head markers
├── Implement batched browser DOM head reconciler with custom tag key/tuple identity
├── Implement conflicting static tag superseding with dev warning
└── Add JSON-LD script breakout protection (\u003C/script\u003E)

PHASE 4: Authoritative Origin Resolution & Canonical Path Normalization
├── Implement server-side siteUrl resolution (PUBLIC_URL fallback with origin validation)
├── Implement production fail-fast validator with concise error message
├── Implement automatic current-route canonical URL derivation
└── Implement canonical path normalizer (strip queries/hashes, trailing slash policy)

PHASE 5: Route Metadata Contracts & HTTP Statuses
├── Export RouteMeta TypeScript module augmentation
├── Implement status code handler (setResponseStatus and meta.ssr.status)
└── Connect HTTP 4xx/5xx statuses to automatic noindex defaults and precedence

PHASE 6: Static Sitemap & Robots.txt Infrastructure
├── Implement static route discovery engine from Vue Router tree (handling pathless parents)
├── Implement XML sitemap serializer, caching headers & physical file collision checks
└── Implement /robots.txt endpoint with standard defaults and physical file collision checks

PHASE 7: Server-Only Dynamic Sitemap Extension
├── Implement defineSitemap helper with SitemapContext in vue-ssr-lite/server
└── Connect dynamic sitemap provider (sitemap.config.ts) to /sitemap.xml endpoint

PHASE 8: usePublicConfig<T>() Transport Cleanup & Serialization Security
├── Implement safe server-to-client configuration serializer with script breakout protection
└── Expose universal usePublicConfig<T>() composable

PHASE 9: Builto Landing Migration & Cleanup
├── Update Builto Landing to use new defineApplication() and useSeo()
└── Delete legacy files (LandingSsrContext, PublicSsrSeo, PublicSiteOrigin, etc.)

PHASE 10: Comprehensive Test Suite & Production Verification
└── Execute full verification test matrix across SSR, Client, Sitemap, DX, and Security
```

---

## 19. Validation & Verification Test Matrix

| Area | Test Scenario | Expected Outcome |
|---|---|---|
| **SSR Registration** | `useSeo()` called in `setup()` | SEO tags present in SSR HTML without waiting for `onMounted()` |
| **DX / Types** | Minimal TypeScript consumer | Autocomplete works for `useSeo()` and `meta.seo`; invalid keys fail type-check without manual `RouteMeta` augmentation |
| **DX / Types** | Strict type contract | `title` is string; `UseSeoInput` accepts `Ref`/`ComputedRef`/getters; `robots` meta separate from `robotsTxt` |
| **DX / Types** | Server-only bundle guard | `sitemap.config.ts` or server utilities cannot be imported into client bundle |
| **SSR** | Concurrent requests with different routes | Request A and Request B do not leak or share SEO state |
| **SSR** | Asynchronous page data resolution (`await fetch...`) | Final `<head>` contains resolved title, not `undefined` |
| **SSR** | HTTP 404 Not Found route | Response status is 404; `<meta name="robots" content="noindex, follow">` present |
| **SSR** | Production canonical resolution | Emits authoritative canonical URL matching `PUBLIC_URL` / `siteUrl` |
| **SSR** | Production missing `PUBLIC_URL` | Fails fast with clear actionable error; never emits `localhost` |
| **Origin Normalization**| Malformed `PUBLIC_URL=https://ex.com/p?q=1#h` | Rejects/strips path, query, hash; canonical resolves to `https://ex.com/route` |
| **Private Mode** | `defineApplication({ seo: { mode: 'private' } })` | `document.title` and `<title>` work; no canonical emitted; no sitemap/robots generated; no `PUBLIC_URL` required |
| **Client** | Route navigation (Page A ➔ Page B) | Page A's SEO is discarded; Page B's SEO applied to DOM |
| **Client** | Component unmount (Modal with `useSeo`) | Unmounting modal restores underlying page SEO state |
| **Client** | `<KeepAlive>` Page Navigation | Page A deactivation suspends SEO; Page B applies SEO; returning to Page A restores Page A's SEO |
| **Client** | Hydration tag reconciliation | Reconciles existing marked SSR tags; zero duplicate `<meta>`/`<link>` tags created |
| **Client** | Conflicting static tag in `index.html` | Managed SEO supersedes static tag; logs dev warning; zero duplicate tags |
| **Client** | Consumer `index.html` tags | Unmarked user tags (favicons, fonts, scripts) remain untouched |
| **Client** | Batched Reconciliation | Head updates committed in one pass on route changes; no intermediate title/meta flash |
| **Client** | Browser Back/Forward navigation | SEO state accurately reflects active history state |
| **Advanced Head** | Custom `meta[]` and `links[]` | Custom meta/link entries rendered in SSR, adopted in hydration, cleaned on route change |
| **Sitemap** | Static nested routes | Resolved paths (including pathless parents) included in sitemap |
| **Sitemap** | Route exclusions | Redirects, aliases, catch-alls, and `meta.seo.index: false` excluded |
| **Sitemap** | Physical file collision | If `public/sitemap.xml` exists, physical file is served without running generator |
| **Multi-App Sitemap** | Dynamic sitemap `SitemapContext` | `context.applicationId` and `context.siteUrl` accurately reflect active tenant |
| **Robots** | Physical file collision | If `public/robots.txt` exists, physical file is served |
| **Security** | Spoofed `Host` header | Request canonical URL remains authoritative; does not reflect spoofed host |
| **Security** | JSON-LD script breakout | `</script>` tags in JSON-LD escaped to `\u003C/script\u003E` |
| **Security** | `publicConfig` payload escaping | Malicious/script-like `publicConfig` strings cannot escape hydration script |
| **Multi-App** | Multi-tenant isolation | App A and App B maintain completely isolated origins and sitemaps |
| **Basic Fixture** | `fixtures/basic-consumer/` | Basic zero-config app runs with zero SSR glue code |
| **Advanced Fixture**| `fixtures/advanced-consumer/` | Advanced app tests `publicConfig`, dynamic sitemap, multi-app context, custom head |
| **Production**| Full build & start (`builto-landing`) | Production build runs with zero SSR glue code |

---

## 20. Builto Landing Target End-State & Acceptance Criteria

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
