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
                  main.ts                  Pages
                     │                       │
           defineApplication()          useSeo(...)
                     │                       │
                     └───────────┬───────────┘
                                 │
                                 ▼
                        ┌────────────────┐
                        │  vue-ssr-lite  │
                        │  (Standalone)  │
                        │                │
                        │ Application    │
                        │ Router         │
                        │ SSR Lifecycle  │
                        │ Hydration      │
                        │ SEO State      │
                        │ Head Sync      │
                        │ Canonical URLs │
                        │ /sitemap.xml   │
                        │ /robots.txt    │
                        │ HTTP Statuses  │
                        │ Public Origin  │
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

### Core Architecture Highlights

1. **Standalone SSR & SEO Engine**: `vue-ssr-lite` owns the full SSR and SEO lifecycle. It has **no dependency** on `vlite3` or any external UI library.
2. **No Third SEO Package**: SEO primitives live directly in `vue-ssr-lite`. No `@vue-ssr-lite/seo-core` package.
3. **No `<SeoProvider>` Required**: Developers call `useSeo()` directly in any component or page. Request-local and client-local SEO state is managed automatically.
4. **Universal API**: The exact same `useSeo()` call works during SSR (generating `<head>` tags and JSON-LD) and during client-side navigation (updating `document.title` and DOM `<head>`).
5. **Safe Canonical & Origin Resolution**: Production canonical URLs never blindly trust untrusted `Host` headers. Origin resolution prefers authoritative configuration (`PUBLIC_URL` / `seo.siteUrl`).
6. **Generic Route Metadata**: `vue-ssr-lite` understands only its own namespaces (`meta.seo` and `meta.ssr`), never application-specific fields like `requiresAuth` or `notFound`.
7. **Zero Application SSR Glue**: Eliminates custom entrypoints, custom SSR servers, custom hydration glue, and ad-hoc SSR contexts from hosted applications.

---

## 2. Progressive API Hierarchy

The API is structured in three clear levels so developers only encounter complexity when their application genuinely requires it:

```text
LEVEL 1 — Normal Application Developer (90% of use cases)
├── defineApplication()
└── useSeo()

LEVEL 2 — Applications Requiring Server-to-Client Configuration
└── usePublicConfig<T>()

LEVEL 3 — Server / Platform Infrastructure Developer
├── defineSsrConfig()
├── useSsrRequestContext()
├── setResponseStatus()
└── Custom server endpoints & hooks
```

---

## 3. Hosted Application Structure

A hosted application using `vue-ssr-lite` is a completely standard Vue 3 project:

```text
builto-landing/
│
├── index.html
├── vite.config.ts
│
└── src/
    ├── main.ts
    ├── App.vue
    ├── routes.ts
    │
    └── pages/
        ├── Home.vue
        ├── About.vue
        ├── Contact.vue
        └── NotFound.vue
```

### Files Eliminated from Hosted Applications

Hosted applications **no longer need**:

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
└── src/config/LandingPublicRuntime.ts (or reduce to standard app config)
```

And for most applications:

```text
ssr.config.ts  ──> UNNECESSARY (use defaults)
```

---

## 4. `main.ts` & `defineApplication()`

`defineApplication` is the primary entrypoint for declaring application setup, routes, plugins, and global SEO defaults.

### Minimal `main.ts`

```ts
import { defineApplication } from 'vue-ssr-lite'
import App from './App.vue'
import routes from './routes'

export default defineApplication({
  root: App,
  routes,
})
```

### `main.ts` with Global SEO Defaults & Plugins

```ts
import { defineApplication } from 'vue-ssr-lite'
import App from './App.vue'
import routes from './routes'
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

    // Optional: siteUrl can also be set via PUBLIC_URL env var
    siteUrl: process.env.PUBLIC_URL,
  },
})
```

> **Note:** All `seo` configurations in `defineApplication` are completely optional. A project without any SEO configuration still renders and functions properly.

---

## 5. Universal SEO Composable: `useSeo()`

`vue-ssr-lite` exports `useSeo()` as a first-class composable that operates seamlessly across both SSR and client-side navigation.

### Minimal Page Usage

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

### Automatic Property Propagation (Zero Duplication)

Developers do not need to duplicate titles, descriptions, and images for Open Graph and Twitter cards. The library derives them automatically:

```ts
// Developer writes:
useSeo({
  title: 'About',
  description: 'Learn about us.',
  image: '/social/about.png',
})

// vue-ssr-lite automatically derives:
// - <title>About | Builto</title>
// - <meta name="description" content="Learn about us.">
// - <link rel="canonical" href="https://builto.com/about">
// - <meta property="og:title" content="About | Builto">
// - <meta property="og:description" content="Learn about us.">
// - <meta property="og:image" content="https://builto.com/social/about.png">
// - <meta name="twitter:title" content="About | Builto">
// - <meta name="twitter:description" content="Learn about us.">
// - <meta name="twitter:image" content="https://builto.com/social/about.png">
// - <meta name="twitter:card" content="summary_large_image">
```

### Full `useSeo()` Options

```ts
useSeo({
  title: 'Introducing Workspaces',
  description: 'Collaborate in real-time with team workspaces.',
  image: '/images/workspaces-preview.png',
  canonical: '/blog/introducing-workspaces',

  robots: {
    index: true,
    follow: true,
  },

  openGraph: {
    type: 'article',
    // Custom overrides if different from base title/image:
    title: 'Workspaces in Builto',
  },

  twitter: {
    card: 'summary_large_image',
  },

  structuredData: [
    {
      '@type': 'Article',
      headline: 'Introducing Workspaces',
      image: '/images/workspaces-preview.png',
    },
  ],
})
```

### SEO Precedence Hierarchy

When multiple sources declare SEO properties, the final state is resolved by strict precedence:

```text
PAGE useSeo()
      >
ROUTE meta.seo
      >
APPLICATION defineApplication.seo
      >
LIBRARY DEFAULTS
```

---

## 6. Structured Data (JSON-LD)

Structured data represents business meaning and domain knowledge. The application declares the content, while `vue-ssr-lite` handles the technical infrastructure.

### Division of Responsibility

| Responsibility | Owner |
|---|---|
| Schema content & business meaning | **Application** |
| Validation & formatting helpers (`defineStructuredData`, schema utilities) | **vue-ssr-lite** |
| JSON-LD serialization & escaping | **vue-ssr-lite** |
| `<script type="application/ld+json">` SSR insertion | **vue-ssr-lite** |
| DOM synchronization on client-side route changes | **vue-ssr-lite** |
| Schema deduplication | **vue-ssr-lite** |

### Usage Example

```ts
import { useSeo } from 'vue-ssr-lite'

useSeo({
  title: 'About Builto',
  structuredData: [
    {
      '@type': 'Organization',
      name: 'Builto',
      url: 'https://builto.com',
      logo: 'https://builto.com/logo.png',
    },
    {
      '@type': 'WebSite',
      name: 'Builto',
      url: 'https://builto.com',
    },
  ],
})
```

---

## 7. Safe Public Origin & Canonical Resolution

Generating canonical URLs in production requires safe, authoritative origin resolution. Raw `Host` headers cannot be blindly trusted in production (preventing cache-poisoning, preview host leakage, or proxy confusion).

### Origin Resolution Strategy

```text
PRODUCTION RESOLUTION:
1. defineApplication({ seo: { siteUrl: 'https://builto.com' } })
2. process.env.PUBLIC_URL
3. Explicitly configured trusted proxy origin (via defineSsrConfig)
4. Fallback: warn / fail when absolute canonical URLs are required

DEVELOPMENT RESOLUTION:
1. Configured siteUrl (if present)
2. Current local dev server origin (http://localhost:<port>)
```

### Relative Path Expansion

Developers supply clean relative canonical paths; `vue-ssr-lite` safely combines them with the authoritative origin:

```ts
useSeo({
  canonical: '/pricing',
})
```

Outputs:

```html
<link rel="canonical" href="https://builto.com/pricing">
<meta property="og:url" content="https://builto.com/pricing">
```

---

## 8. Route Metadata & Namespace Rules

`vue-ssr-lite` interacts only with its own dedicated namespaces in Vue Router route definitions: `meta.seo` and `meta.ssr`. It **never** reads application-specific fields like `meta.requiresAuth`, `meta.auth`, or `meta.notFound`.

### Route Definition Example

```ts
import { RouteRecordRaw } from 'vue-router'
import Home from '../pages/Home.vue'
import About from '../pages/About.vue'
import Dashboard from '../pages/Dashboard.vue'
import NotFound from '../pages/NotFound.vue'

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
      // Application handles auth conventions; declares SEO intent explicitly:
      seo: {
        index: false,
      },
    },
  },
  {
    path: '/:pathMatch(.*)*',
    component: NotFound,
    meta: {
      ssr: {
        status: 404,
      },
      seo: {
        index: false,
      },
    },
  },
]
```

### HTTP Response Status Control

Applications control HTTP response codes using generic HTTP semantics:

1. **Declarative route metadata**:
   ```ts
   meta: {
     ssr: { status: 404 }
   }
   ```
2. **Imperative status composable**:
   ```ts
   import { setResponseStatus } from 'vue-ssr-lite'

   setResponseStatus(404)
   ```

---

## 9. Sitemap Generation (`/sitemap.xml`)

`vue-ssr-lite` automates the sitemap endpoint and XML generation while relying on the application for dynamic entity discovery.

### Division of Responsibility

| Responsibility | Owner |
|---|---|
| `/sitemap.xml` HTTP endpoint & routing | **vue-ssr-lite** |
| XML generation, formatting & entity escaping | **vue-ssr-lite** |
| Content-Type (`application/xml`) & cache headers | **vue-ssr-lite** |
| Absolute URL resolution using authoritative `siteUrl` | **vue-ssr-lite** |
| Static route discovery from router definitions | **vue-ssr-lite** |
| Filtering out non-indexable routes (`meta.seo.index: false`) | **vue-ssr-lite** |
| Deduplication & sitemap index support | **vue-ssr-lite** |
| Dynamic route parameters (e.g. `/blog/:slug`, `/products/:id`) | **Application** |
| Custom priority & change frequency | **Application** |

### Dynamic Route Entries in `defineApplication`

For sites with dynamic database routes:

```ts
export default defineApplication({
  root: App,
  routes,

  seo: {
    siteUrl: 'https://builto.com',
    sitemap: {
      async entries() {
        const posts = await fetchBlogSlugs()
        return posts.map(slug => ({
          loc: `/blog/${slug}`,
          lastmod: new Date().toISOString(),
          changefreq: 'weekly',
          priority: 0.8,
        }))
      },
    },
  },
})
```

For static sites without dynamic routes: **Zero sitemap code is required.**

---

## 10. `robots.txt` Endpoint (`/robots.txt`)

`vue-ssr-lite` automatically serves `/robots.txt` with safe, standard defaults:

### Default Output

```text
User-agent: *
Allow: /

Sitemap: https://builto.com/sitemap.xml
```

### Principles

- `robots.txt` is **not** an access control or authentication mechanism.
- `vue-ssr-lite` does **not** automatically scrape route paths to create disallow lists.
- Private routes are protected by access control and excluded from search engines via `meta.seo.index: false` (`noindex`).
- Applications may explicitly declare custom disallow rules when desired:

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

## 11. Runtime Configuration Transport: `usePublicConfig<T>()`

Server-resolved configuration values often need to be safely transferred to the browser during SSR hydration (such as API endpoints, public feature flags, and environment identifiers) without maintaining bespoke context boilerplate.

### Server-to-Client Transport Pipeline

```text
SERVER
process.env / config resolution
         ↓
SSR Request Context
         ↓
Safe serialization into HTML payload
         ↓
BROWSER
Hydration payload restoration
         ↓
usePublicConfig<T>()
```

### Application Usage

In `main.ts`:

```ts
export default defineApplication({
  root: App,
  routes,

  publicConfig: () => ({
    apiUrl: process.env.PUBLIC_API_URL || 'https://api.builto.com',
    environment: process.env.NODE_ENV,
  }),
})
```

In any component or composable:

```vue
<script setup lang="ts">
import { usePublicConfig } from 'vue-ssr-lite'

interface AppConfig {
  apiUrl: string
  environment: string
}

const config = usePublicConfig<AppConfig>()
console.log('API URL:', config.apiUrl)
</script>
```

---

## 12. Internal SSR & SEO Pipeline

```text
SSR REQUEST LIFECYCLE
Request
   │
   ▼
vue-ssr-lite SsrApplicationRuntime
   │
   ├── Resolve application definition & routes
   ├── Resolve trusted site URL (siteUrl / PUBLIC_URL)
   ├── Create request & response contexts
   ├── Initialize request-scoped SEO store
   ├── Create SSR Vue app & router instance
   ├── Navigate router to requested URL
   │
   ▼
Vue Component Tree
   │
   └── Page setup() calls useSeo(...)
           │
           ▼
     Updates request-scoped SEO store
           │
           ▼
vue-ssr-lite Server Engine
   │
   ├── renderToString() executes
   ├── Finalize SEO state (merge page > route > app > defaults)
   ├── Generate <title>, <meta>, canonical <link>, OG, Twitter tags
   ├── Serialize JSON-LD structured data
   ├── Inject head tags into HTML template
   ├── Serialize hydration payload (publicConfig, SEO state)
   └── Return HTTP response with resolved status code


CLIENT-SIDE NAVIGATION LIFECYCLE
Hydration
   │
   ├── Vue hydrates server-rendered DOM
   └── Restore initial SEO state
   │
   ▼
User navigates to new route
   │
   ├── Vue Router resolves new page component
   ├── Page setup() calls useSeo(...)
   ├── SEO store updates for active route
   └── DOM Head Synchronizer updates document.title, <meta>, canonical, and JSON-LD scripts
```

---

## 13. Relationship with `vlite3`

`vue-ssr-lite` maintains complete independence from `vlite3`:

```text
        vue-ssr-lite (Standalone SSR + SEO primitives)
              ▲
              │ (optional integration / re-export)
            vlite3 (UI components & SPA tools)
```

- `vue-ssr-lite` **never** imports or depends on `vlite3`.
- `vlite3` may optionally re-export or wrap `useSeo` for convenience in SPA or UI-only environments.
- Applications using `vue-ssr-lite` import SEO primitives directly:
  ```ts
  import { useSeo } from 'vue-ssr-lite'
  ```

---

## 14. When `ssr.config.ts` Is Needed

`ssr.config.ts` is strictly reserved for infrastructure-level exceptions:

```ts
import { defineSsrConfig } from 'vue-ssr-lite'

export default defineSsrConfig({
  server: {
    trustProxy: true,
    port: 3000,
  },
})
```

`ssr.config.ts` should **never** contain:
- SEO titles or descriptions
- Sitemap XML logic
- Application routes
- Business logic or API adapters

For standard projects, **no `ssr.config.ts` file is needed.**

---

## 15. Complete Responsibility Matrix

| Capability | `vue-ssr-lite` | Hosted Application | `vlite3` |
|---|:---:|:---:|:---:|
| `createSSRApp()` / `createApp()` lifecycle | **OWNS** | — | — |
| Request isolation & context management | **OWNS** | — | — |
| `renderToString()` & hydration execution | **OWNS** | — | — |
| Request-scoped & client-side SEO store | **OWNS** | — | — |
| `useSeo()` implementation | **OWNS** | — | Optional consumer |
| Head generation & DOM head synchronization | **OWNS** | — | — |
| Canonical URL assembly & path expansion | **OWNS** | — | — |
| Safe origin resolution (`PUBLIC_URL` / `siteUrl`) | **OWNS** | — | — |
| `/sitemap.xml` endpoint & XML serialization | **OWNS** | — | — |
| Static route discovery for sitemap | **OWNS** | — | — |
| Dynamic sitemap entries | — | **OWNS** | — |
| `/robots.txt` endpoint & standard formatting | **OWNS** | — | — |
| HTTP response status code setting (404, etc.) | **OWNS** | — | — |
| `usePublicConfig<T>()` transport & serialization | **OWNS** | — | — |
| JSON-LD validation, serialization & insertion | **OWNS** | — | — |
| Structured data content & business schemas | — | **OWNS** | Optional schema helpers |
| Page titles, descriptions, social images | — | **OWNS** | — |
| Global site branding & default SEO | — | **OWNS** | — |
| UI Component library | — | — | **OWNS** |

---

## 16. Target Implementation in Builto Landing

### 1. `src/main.ts`

```ts
import { defineApplication } from 'vue-ssr-lite'
import App from './App.vue'
import { routes } from './routes'

export default defineApplication({
  root: App,
  routes,

  seo: {
    siteName: 'Builto',
    title: {
      default: 'Builto',
      template: '%s | Builto',
    },
    description:
      'Create websites, documents, and organize your work in one workspace.',
    image: '/assets/brand/social-card.png',
  },
})
```

### 2. `src/routes.ts`

```ts
import { RouteRecordRaw } from 'vue-router'
import Home from './pages/Home.vue'
import About from './pages/About.vue'
import Pricing from './pages/Pricing.vue'
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
    path: '/pricing',
    component: Pricing,
  },
  {
    path: '/:pathMatch(.*)*',
    component: NotFound,
    meta: {
      ssr: { status: 404 },
      seo: { index: false },
    },
  },
]
```

### 3. `src/pages/About.vue`

```vue
<script setup lang="ts">
import { useSeo } from 'vue-ssr-lite'

useSeo({
  title: 'About',
  description: 'Learn about Builto and our mission to simplify productivity.',
  canonical: '/about',
})
</script>

<template>
  <div class="about-page">
    <h1>About Builto</h1>
    <p>Builto is an all-in-one workspace designed for creators and teams.</p>
  </div>
</template>
```

### 4. `src/pages/NotFound.vue`

```vue
<script setup lang="ts">
import { useSeo } from 'vue-ssr-lite'

useSeo({
  title: 'Page Not Found',
})
</script>

<template>
  <div class="not-found-page">
    <h1>404 — Page Not Found</h1>
    <router-link to="/">Return Home</router-link>
  </div>
</template>
```

---

## 17. Summary Checklist for `vue-ssr-lite` Implementation

- [ ] **Core SSR**: Standalone request-isolated `renderToString` and browser hydration pipeline.
- [ ] **SEO Store**: Request-scoped (SSR) and reactive (browser) SEO state management.
- [ ] **`useSeo()` Composable**: Universal head and meta tag management with automatic property propagation (OG/Twitter cards).
- [ ] **Origin Resolution**: Authoritative origin determination via `PUBLIC_URL` / `seo.siteUrl`, with dev localhost fallback and protection against raw `Host` header poisoning.
- [ ] **Generic Metadata**: Processing of `meta.seo` and `meta.ssr` namespaces; status code setting via `setResponseStatus` and route metadata.
- [ ] **Sitemap Endpoint**: Automatic static route discovery, dynamic `sitemap.entries()` hook, and XML serialization at `/sitemap.xml`.
- [ ] **Robots Endpoint**: Standard `/robots.txt` generation with sitemap reference and optional custom disallow configuration.
- [ ] **Public Config**: Type-safe server-to-client configuration transport via `usePublicConfig<T>()`.
- [ ] **Structured Data Engine**: JSON-LD serialization, deduplication, and insertion.
- [ ] **Zero Framework Coupling**: Independent from `vlite3` without intermediary packages.
