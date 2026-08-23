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
4. **Universal API with Reactive Scoping**: `useSeo()` works identically during SSR (waiting for async page settling) and browser navigation (with automatic component-unmount and `<KeepAlive>` lifecycle cleanup).
5. **Safe Canonical & Origin Resolution**: Production canonical URLs resolve authoritatively from `process.env.PUBLIC_URL`, `defineApplication({ seo: { siteUrl } })`, or server configuration. Raw `Host` headers are never trusted in production.
6. **Strict Server-Only Boundaries**:
   - `src/main.ts` is universal: developers **never** write `process.env` in `main.ts`.
   - Dynamic sitemap queries (databases, private APIs) live in server-only modules (`sitemap.config.ts` or `server/sitemap.ts`).
7. **Unified SEO Contract (`SeoInput`)**: Application defaults, route metadata, and page composables share **one consistent SEO schema**.
8. **Breaking Cleanup Allowed**: No legacy SSR bridges or temporary dual-layer adapters are carried forward. Clean, unified contracts only.

---

## 2. Developer Personas & Progressive API Hierarchy

The architecture is designed to support four distinct developer personas with progressive disclosure of complexity:

```text
PERSONA A — JUNIOR / FIRST SSR PROJECT (Zero SSR knowledge required)
├── defineApplication({ root: App, routes })
└── useSeo({ title, description })
└── Deployment: PUBLIC_URL=https://example.com

PERSONA B — NORMAL MID-LEVEL APPLICATION DEVELOPER
├── defineApplication({ seo: { siteName, title, image } })
└── Route metadata: meta.seo, meta.ssr

PERSONA C — SENIOR APPLICATION DEVELOPER
├── usePublicConfig<T>()
├── sitemap.config.ts (Dynamic sitemap data provider)
├── JSON-LD structured data
├── Custom canonical overrides & trailing slash policies
└── Internal app escape hatch: defineApplication({ seo: false })

PERSONA D — PLATFORM & INFRASTRUCTURE ENGINEER
├── ssr.config.ts (defineSsrConfig)
├── useSsrRequestContext()
├── Custom-domain origin resolvers (resolveSiteUrl)
├── setResponseStatus()
└── Custom server middleware, hooks & caching overrides
```

### API Classification

| Category | Exports | Boundary |
|---|---|---|
| **Normal (Level 1)** | `defineApplication`, `useSeo` | Universal (`src/`) |
| **Common (Level 2)** | `usePublicConfig` | Universal (`src/`) |
| **Advanced** | `setResponseStatus` | Universal (`src/`) |
| **Server-Only (Level 3)** | `defineSsrConfig`, `defineSitemap`, `useSsrRequestContext` | Server-Only (`*.config.ts`, `server/`) |

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
    title: {
      default: 'Builto',
      template: '%s | Builto',
    },
    description: 'Create websites, documents, and organize your workspace.',
    image: '/assets/brand/social-card.png',
  },
})
```

### Step 3: Escape Hatch for Internal / Non-Public Applications (Persona C)

If an application is an internal dashboard, private portal, or behind an intranet where public SEO features (sitemaps, robots.txt, canonical URLs, `PUBLIC_URL` validation) are not desired:

```ts
export default defineApplication({
  root: App,
  routes,
  seo: false, // Disables sitemap.xml, robots.txt, canonical generation & PUBLIC_URL requirement
})
```

---

## 5. Unified Public SEO Schema (`SeoInput`)

To eliminate cognitive friction, **Application SEO, Route SEO, and Page SEO share the exact same core schema**. A developer uses the same property names everywhere.

### Core Type Definitions

```ts
/** Core SEO input schema used across Page, Route, and Application levels */
export interface SeoInput {
  title?: string
  description?: string
  image?: string
  canonical?: string | false
  index?: boolean
  follow?: boolean
  openGraph?: {
    type?: 'website' | 'article' | 'profile' | 'book'
    title?: string
    description?: string
    image?: string
    url?: string
  }
  twitter?: {
    card?: 'summary' | 'summary_large_image' | 'app' | 'player'
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
}

/** Route-level metadata schema */
export type SeoRouteInput = Pick<
  SeoInput,
  'title' | 'description' | 'image' | 'canonical' | 'index' | 'follow' | 'robots'
> & {
  sitemap?: boolean
}

/** Global application defaults schema */
export type SeoApplicationDefaults = SeoInput & {
  siteName?: string
  title?: string | { default?: string; template?: string }
  trailingSlash?: boolean
}
```

### TypeScript Module Augmentation Built-In

```ts
// Built into vue-ssr-lite — no manual app-level augmentation needed:
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

### 6.1 Standard Page Usage (Automatic Canonical)

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
- `<link rel="canonical" href="https://builto.com/about">` (automatically derived from current route)
- `<meta property="og:title" content="About | Builto">`
- `<meta property="og:description" content="Learn more about Builto and our mission.">`
- `<meta property="og:url" content="https://builto.com/about">`
- `<meta name="twitter:title" content="About | Builto">`
- `<meta name="twitter:description" content="Learn more about Builto and our mission.">`
- `<meta name="twitter:card" content="summary_large_image">`

### 6.2 Advanced Overrides

Manual overrides are used only when intentionally deviating from standard behavior:

```ts
useSeo({
  title: 'Introducing Workspaces',
  canonical: '/blog/introducing-workspaces', // Explicit path override
  // canonical: 'https://other-domain.com/article', // Absolute cross-domain canonical
  // canonical: false, // Disables canonical link tag
  index: false, // Emits noindex
  openGraph: {
    title: 'Custom Social Title', // Override if different from <title>
  },
})
```

### 6.3 Deterministic Scoping Hierarchy

SEO precedence is determined by **component hierarchy**, never by unpredictable mount timing:

```text
APPLICATION DEFAULTS (defineApplication.seo)
            <
ROUTE METADATA (route.meta.seo)
            <
LAYOUT CONTRIBUTIONS (useSeo in App / Layout)
            <
PAGE CONTRIBUTIONS (useSeo in active Page)
            <
DESCENDANT COMPONENT (useSeo in Child / Modal)
```

- **Within the same component instance**: The latest `useSeo()` call updates and overrides previous properties.
- **For sibling components at equal depth**: Follows stable Vue component creation order (with best practice recommending page-level metadata at the page/layout level).

### 6.4 Lifecycle & `<KeepAlive>` Support

`useSeo()` binds to the active component instance and manages contribution lifecycles:

- **Mounting (`onMounted`)**: Registers the component's SEO contribution.
- **Unmounting (`onUnmounted`)**: Cleans up the contribution, restoring ancestor/page values.
- **Route Navigation**: Clears the leaving page's contribution so properties (e.g. `image: 'a.png'`) never leak into the next page.
- **`<KeepAlive>` Caching (`onActivated` / `onDeactivated`)**:
  - When Page A is cached in `<KeepAlive>` and deactivated, its SEO contribution is **suspended**.
  - When Page A is reactivated, its SEO contribution is **restored**.

### 6.5 Reactivity & Defined Async Settling Sources

`useSeo()` accepts standard Vue reactive inputs (`Ref`, `ComputedRef`, or getter functions `() => T`):

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import { useSeo } from 'vue-ssr-lite'

const props = defineProps<{ slug: string }>()
const article = ref<{ title: string; excerpt: string } | null>(null)

// Plain Vue async setup (supported out of the box):
article.value = await fetchArticle(props.slug)

useSeo({
  title: computed(() => article.value?.title || 'Article'),
  description: () => article.value?.excerpt,
})
</script>
```

#### Exact SSR Settling Sources:
SSR captures the final SEO snapshot **only after** these registered sources have settled:
1. **Vue async `setup()`** (components using top-level `await`);
2. **`<Suspense>` dependencies**;
3. **`vue-ssr-lite` router navigation hooks**;
4. **Registered plugin resolution promises**.

*(The library does not claim to detect arbitrary untracked background promises.)*

---

## 7. Head Tag Ownership Markers & Hydration Reconciliation

To prevent duplicate tags and protect consumer-owned elements in `index.html`, `vue-ssr-lite` places explicit internal ownership markers on all managed head elements.

### Managed Ownership Attributes

```html
<title data-vue-ssr-lite-head="title">About | Builto</title>
<meta name="description" content="..." data-vue-ssr-lite-head="description">
<link rel="canonical" href="..." data-vue-ssr-lite-head="canonical">
<meta property="og:title" content="..." data-vue-ssr-lite-head="og:title">
<meta name="twitter:card" content="..." data-vue-ssr-lite-head="twitter:card">
<script type="application/ld+json" data-vue-ssr-lite-head="json-ld">...</script>
```

### Reconciliation Algorithm

1. **SSR Generation**: Injects managed tags with their corresponding `data-vue-ssr-lite-head="<key>"` marker.
2. **Client Hydration**: Adopts existing marked DOM nodes without recreating elements.
3. **Client Navigation**: Computes diffs and updates only nodes with `data-vue-ssr-lite-head` attributes.
4. **Consumer Safety**: Unmarked tags in `index.html` (favicons, fonts, external stylesheets, analytics scripts) are **never modified or removed**.

---

## 8. Safe Public Origin & "One Deployment URL"

### 8.1 Resolution Invariant

For 99% of public deployments:
- **Zero SSR source code required.**
- **One authoritative deployment URL**: `PUBLIC_URL=https://builto.com`.

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

## 9. Route Metadata & HTTP 404 Handling

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

### 9.2 Safe 4xx/5xx Defaults

- Setting `meta.ssr.status = 404` (or any 4xx/5xx code) automatically implies `index: false` (`noindex`).
- Developers do not need to write redundant `seo: { index: false }` on error routes.

---

## 10. Sitemap Infrastructure (`/sitemap.xml`)

### 10.1 Static Route Discovery Rules

`vue-ssr-lite` automatically discovers indexable static routes from the router tree:

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

For dynamic content, applications provide an optional `sitemap.config.ts` at the project root (or `server/sitemap.ts`):

```ts
// sitemap.config.ts (SERVER-ONLY — Never bundled into client!)
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
    robots: {
      disallow: ['/internal-preview/'],
    },
  },
})
```

---

## 12. Structured Data (JSON-LD)

- **Application Responsibility**: Supplies schema content and domain meaning.
- **Library Responsibility**: Structural validation (object/array check), JSON-LD serialization, character escaping, script breakout prevention (`</script>` ➔ `\u003C/script\u003E`), script tag insertion, and DOM reconciliation.

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

## 13. Runtime Configuration Transport (`usePublicConfig<T>`) — Level 2

Safe server-to-client configuration transport without application context boilerplate:

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
| Scoped & reactive SEO store | **OWNS** | — | — |
| `useSeo()` implementation | **OWNS** | — | Optional consumer |
| Head reconciliation & ownership markers | **OWNS** | — | — |
| Automatic canonical URL derivation | **OWNS** | — | — |
| Safe origin resolution (`PUBLIC_URL` / `siteUrl`) | **OWNS** | — | — |
| Static route discovery for sitemap | **OWNS** | — | — |
| Dynamic sitemap execution & endpoint | **OWNS** | **OWNS** (`sitemap.config.ts`) | — |
| `/robots.txt` endpoint & standard formatting | **OWNS** | — | — |
| HTTP response status codes & 404 defaults | **OWNS** | — | — |
| `usePublicConfig<T>()` transport & serialization | **OWNS** | — | — |
| JSON-LD structural validation, escaping & insertion | **OWNS** | — | — |
| Structured data business schema content | — | **OWNS** | Optional schema helpers |
| Page titles, descriptions, social images | — | **OWNS** | — |
| Global site branding & default SEO | — | **OWNS** | — |
| UI Component library | — | — | **OWNS** |

---

## 17. Phased Implementation Plan

```text
PHASE 0: Public API & DX Contract Freeze
├── Freeze unified SeoInput, SeoRouteInput, and SeoApplicationDefaults types
├── Freeze useSeo() function signature and reactive input types
├── Freeze RouteMeta module augmentation
├── Freeze ownership marker format (data-vue-ssr-lite-head="<key>")
└── Freeze server-only file conventions (sitemap.config.ts, ssr.config.ts)

PHASE 1: Core SEO Types & Request/Client SEO Store
├── Implement request-scoped SEO store for SSR
└── Implement reactive client-scoped SEO store

PHASE 2: useSeo() Lifecycle, Reactivity & Scoped Cleanup
├── Implement useSeo() bound to getCurrentInstance()
├── Implement onUnmounted() contribution cleanup
├── Implement onActivated() / onDeactivated() for <KeepAlive> support
├── Add support for Ref, ComputedRef, and getter inputs
└── Integrate with SSR async setup / Suspense settling

PHASE 3: SSR Head Finalization & Client Head Reconciliation
├── Implement SSR head tag serializer with data-vue-ssr-lite-head markers
├── Implement browser DOM head reconciler with deterministic diffing
└── Add JSON-LD script breakout protection (\u003C/script\u003E)

PHASE 4: Authoritative Origin Resolution & Canonical Path Normalization
├── Implement server-side siteUrl resolution (PUBLIC_URL fallback)
├── Implement production fail-fast validator with concise error message
├── Implement automatic current-route canonical URL derivation
└── Implement canonical path normalizer (strip queries/hashes, trailing slash policy)

PHASE 5: Route Metadata Contracts & HTTP Statuses
├── Export RouteMeta TypeScript module augmentation
├── Implement status code handler (setResponseStatus and meta.ssr.status)
└── Connect HTTP 4xx/5xx statuses to automatic noindex defaults

PHASE 6: Static Sitemap & Robots.txt Infrastructure
├── Implement static route discovery engine from Vue Router tree
├── Implement XML sitemap serializer, caching headers & physical file collision checks
└── Implement /robots.txt endpoint with standard defaults and physical file collision checks

PHASE 7: Server-Only Dynamic Sitemap Extension
├── Implement defineSitemap helper in vue-ssr-lite/server
└── Connect dynamic sitemap provider (sitemap.config.ts) to /sitemap.xml endpoint

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
└── Execute full verification test matrix across SSR, Client, Sitemap, DX, and Security
```

---

## 18. Validation & Verification Test Matrix

| Area | Test Scenario | Expected Outcome |
|---|---|---|
| **DX / Types** | Minimal TypeScript consumer | Autocomplete works for `useSeo()` and `meta.seo`; invalid keys fail type-check without manual `RouteMeta` augmentation |
| **DX / Types** | Server-only bundle guard | `sitemap.config.ts` or server utilities cannot be imported into client bundle |
| **SSR** | Concurrent requests with different routes | Request A and Request B do not leak or share SEO state |
| **SSR** | Asynchronous page data resolution (`await fetch...`) | Final `<head>` contains resolved title, not `undefined` |
| **SSR** | HTTP 404 Not Found route | Response status is 404; `<meta name="robots" content="noindex, follow">` present |
| **SSR** | Production canonical resolution | Emits authoritative canonical URL matching `PUBLIC_URL` / `siteUrl` |
| **SSR** | Production missing `PUBLIC_URL` | Fails fast with clear actionable error; never emits `localhost` |
| **Internal App**| `defineApplication({ seo: false })` | No `PUBLIC_URL` required; `/sitemap.xml` and `/robots.txt` endpoints disabled |
| **Client** | Route navigation (Page A ➔ Page B) | Page A's SEO is discarded; Page B's SEO applied to DOM |
| **Client** | Component unmount (Modal with `useSeo`) | Unmounting modal restores underlying page SEO state |
| **Client** | `<KeepAlive>` Page Navigation | Page A deactivation suspends SEO; Page B applies SEO; returning to Page A restores Page A's SEO |
| **Client** | Hydration tag reconciliation | Reconciles existing marked SSR tags; zero duplicate `<meta>`/`<link>` tags created |
| **Client** | Consumer `index.html` tags | Unmarked user tags (favicons, fonts, scripts) remain untouched |
| **Client** | Browser Back/Forward navigation | SEO state accurately reflects active history state |
| **Sitemap** | Static nested routes | Concatenated paths (`/docs/intro`) included in sitemap |
| **Sitemap** | Route exclusions | Redirects, aliases, catch-alls, and `meta.seo.index: false` excluded |
| **Sitemap** | Physical file collision | If `public/sitemap.xml` exists, physical file is served without running generator |
| **Sitemap** | Server-only dynamic entries | `sitemap.config.ts` dynamic URLs merged into `/sitemap.xml` |
| **Robots** | Physical file collision | If `public/robots.txt` exists, physical file is served |
| **Security** | Spoofed `Host` header | Request canonical URL remains authoritative; does not reflect spoofed host |
| **Security** | JSON-LD script breakout | `</script>` tags in JSON-LD escaped to `\u003C/script\u003E` |
| **Multi-App** | Multi-tenant isolation | App A and App B maintain completely isolated origins and sitemaps |
| **Fixture** | `fixtures/basic-consumer/` | Basic app runs with zero SSR glue code |
| **Production**| Full build & start (`builto-landing`) | Production build runs with zero SSR glue code |

---

## 19. Builto Landing Target End-State & Acceptance Criteria

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
