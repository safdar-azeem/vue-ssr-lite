# vue-ssr-lite Architecture Refactor Plan

> **Architectural Principle:**  
> **Hosted applications declare intent. `vue-ssr-lite` handles SSR/SEO infrastructure.**  
> **Simple outside. Small inside. Powerful when needed.**  
> **Automate the common 95% safely. Provide lean escape hatches for the remaining 5%.**

> **Extension Rule:**  
> `vue-ssr-lite` uses extensions internally to keep optional features modular,
> but hosted applications are never required to understand or register built-in
> extensions. Built-in capabilities are automatically attached and configured
> declaratively. Only advanced applications that need custom runtime behavior
> use the `extensions` API.

> **Configuration Rule:**  
> Built-in functionality is CONFIGURED, not INSTALLED.  
> Custom functionality is REGISTERED through `extensions`.

---

## 1. Target Architecture & Overview

```text
                         HOSTED VUE APPLICATION
                      (Builto Landing / future apps)

                main.ts                    Page
                   │                        │
         defineApplication()             useSeo()
                   │                        │
                   │                  built-in SEO API
                   │                        │
                   └────────────┬───────────┘
                                │
                                ▼
                     ┌────────────────────┐
                     │ vue-ssr-lite CORE  │
                     │                    │
                     │ Application        │
                     │ Router             │
                     │ SSR Renderer       │
                     │ Hydration          │
                     │ Request Context    │
                     │ Resolution         │
                     │ Extension Runtime  │
                     └─────────┬──────────┘
                               │
                     ┌─────────┴─────────┐
                     │                   │
              BUILT-IN EXTENSIONS   CUSTOM EXTENSIONS
                     │                   │
                     │                   └── extensions: [...]
                     │
                 SEO Extension
                     │
             ┌───────┼─────────┐
             │       │         │
            Head  Sitemap   robots
             │
         Canonical
         OG/Twitter
         JSON-LD

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
11. **Internal Extension Architecture**: Optional feature domains are implemented as internal extensions coordinated by a small, typed extension runtime. The extension mechanism is invisible to normal developers unless they intentionally create a custom extension. `vue-ssr-lite` is NOT a generic plugin framework — the extension system is only a controlled extensibility layer around the existing stable SSR core.

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
├── Custom extensions: defineExtension(), extensions: [...]
└── Custom server middleware, hooks & caching overrides
```

### Public API Surface

| Category | Exports | File Boundary |
|---|---|---|
| **Normal (Level 1)** | `defineApplication`, `useSeo` | Universal (`src/`) |
| **Advanced Application (Level 2)** | `usePublicConfig`, `setResponseStatus` | Universal (`src/`) |
| **Server Configuration (Level 3)** | `defineSsrConfig`, `defineSitemap`, `useSsrRequestContext` | Server-Only (`*.config.ts`, `server/`) |
| **Extension Authoring (Level 4)** | `defineExtension` | Universal (`src/`) |

### Terminology: `plugins` vs `extensions`

Hosted applications already use normal Vue **plugins**:

```ts
plugins: [
  apollo,
  createVLite(),
]
```

Those correspond to `app.use(...)` — standard Vue application plugins.

`vue-ssr-lite` runtime extensions are different. They participate in the SSR lifecycle, contribute to head rendering, register endpoints, and manage request-scoped state. Therefore the architecture clearly distinguishes:

| Term | Meaning |
|---|---|
| `plugins` | Normal Vue application plugins (`app.use(...)`) |
| `extensions` | `vue-ssr-lite` runtime extensions |

These coexist without ambiguity:

```ts
export default defineApplication({
  root: App,
  routes,

  plugins: [
    apollo,
    createVLite(),
  ],

  extensions: [
    myExtension(),
  ],
})
```

### Layered Documentation Structure

1. **Getting Started / Quickstart**: Persona A (Install, Vite plugin, `defineApplication`, `useSeo`, `PUBLIC_URL` deployment). No mention of extension internals.
2. **SEO & Routing Guide**: Persona B (Site-wide defaults, `meta.seo`, `meta.ssr`, 404 handling, private mode). No need to explain that SEO is internally an extension.
3. **Advanced Application Features**: Persona C (`sitemap.config.ts`, `usePublicConfig`, structured data, `meta[]`/`links[]`).
4. **Advanced Extensions Guide**: Persona D (`defineExtension()`, `extensions: []`, extension lifecycle, context, request isolation).
5. **Architecture / Contributor Guide**: Built-in extension architecture, SEO extension implementation, extension runtime internals.

Normal consumers should not need to know the internal architecture.

---

## 3. Internal Extension Architecture

### 3.1 Core Architectural Decision

```text
vue-ssr-lite CORE
       +
BUILT-IN EXTENSIONS
       +
OPTIONAL CUSTOM EXTENSIONS
```

The extension mechanism is:

- **Internal-first**: The primary purpose is internal modularity, not external plugin marketplace.
- **Small**: Minimal lifecycle hooks, minimal infrastructure.
- **Strongly typed**: Extension configuration, context, and state have explicit TypeScript types.
- **Request-safe**: Extension state is scoped per SSR request. Concurrent requests never leak state.
- **Deterministic**: Initialization order is fixed and predictable.
- **Easy to test**: Each extension is independently testable against the extension contract.
- **Easy to extend**: Adding a new built-in or custom extension does not require modifying core.
- **Invisible**: Junior/normal developers never encounter extensions unless they intentionally create one.

### 3.2 What Must NOT Become Extensions

These remain part of the stable `vue-ssr-lite` **core**. They are fundamental runtime functionality, not optional features:

```text
┌───────────────────────────────┐
│       vue-ssr-lite Core       │
│                               │
│ Application Definition        │
│ createSSRApp / createApp      │
│ SSR Renderer                  │
│ renderToString Lifecycle      │
│ Router Creation / History     │
│ Browser Hydration             │
│ Request Isolation             │
│ Request Context               │
│ SSR Resolution / Settling     │
│ Core Serialization / Hydration│
│ Extension Discovery / Runtime │
│ Core Error Handling           │
└───────────────────────────────┘
```

Do **NOT** create:

```text
routerExtension
rendererExtension
hydrationExtension
requestContextExtension
```

That would be over-engineering. The core handles core.

### 3.3 Built-in Extension Enablement Modes

| Mode | Description | Examples |
|---|---|---|
| **CORE** | Not an extension. Fundamental runtime. | SSR rendering, hydration, router runtime, request isolation |
| **DEFAULT** | Built-in extension enabled automatically with safe defaults. | SEO |
| **OPT-IN** | Built-in capability shipped by `vue-ssr-lite` but only activated when configured. | *(future)* diagnostics, advanced caching, performance tooling |

OPT-IN examples are architecture proofs only. Do NOT pre-design or implement them.

### 3.4 Built-in Extensions Are Auto-Attached

Normal users **MUST NOT** write:

```ts
import { seoExtension } from 'vue-ssr-lite'

extensions: [
  seoExtension(),
]
```

SEO must work automatically:

```ts
export default defineApplication({
  root: App,
  routes,
})
```

```vue
<script setup>
useSeo({ title: 'About', description: 'Learn about us.' })
</script>
```

Internally `vue-ssr-lite` resolves something conceptually like:

```ts
const resolvedExtensions = [
  ...resolveBuiltInExtensions(application),
  ...application.extensions,
]
```

The hosted application should not know or care that SEO is implemented internally as an extension.

### 3.5 Built-in Extensions Are Declaratively Configured

> Built-in capabilities are configured. They are not manually installed.

SEO example:

```ts
export default defineApplication({
  root: App,
  routes,

  seo: {
    siteName: 'Builto',
    title: 'Builto',
    titleTemplate: '%s | Builto',
    image: '/social.png',
  },
})
```

Internally:

```text
defineApplication.seo
    ↓
built-in SEO extension configuration
```

The application should **NOT** need:

```ts
extensions: [
  seoExtension({ ... })
]
```

This keeps the public API domain-oriented instead of framework-oriented.

### 3.6 Configuration Responsibility

| Extension Type | Configuration Approach |
|---|---|
| **Built-in extension** | First-class declarative application configuration |
| **Custom extension** | `extensions: [...]` |

Built-in SEO:

```ts
defineApplication({
  seo: {
    siteName: 'Builto',
  },
})
```

Custom feature:

```ts
defineApplication({
  extensions: [
    myExtension({ ... }),
  ],
})
```

This distinction must remain consistent.

### 3.7 Custom Application Extensions

Advanced hosted applications extend the SSR runtime explicitly:

```ts
export default defineApplication({
  root: App,
  routes,

  extensions: [
    myExtension(),
    companyExtension(),
  ],
})
```

Normal developers should **never** need the `extensions` property. Custom extension support is progressive disclosure for senior/platform users.

### 3.8 `defineExtension()` API

The architecture proposes a strongly typed extension factory:

```ts
import { defineExtension } from 'vue-ssr-lite'

export const myExtension = defineExtension({
  name: 'my-extension',
  // minimal supported extension hooks/capabilities
})
```

Or factory form for configurable extensions:

```ts
export function myExtension(options) {
  return defineExtension({
    name: 'my-extension',
    // ...
  })
}
```

Usage:

```ts
extensions: [
  myExtension({ enabled: true }),
]
```

> **Implementation Note:** Do NOT freeze a large lifecycle API before implementation. The exact extension hooks must be derived from real requirements, starting with the SEO built-in extension.

### 3.9 Minimal Extension Contract

Do **not** create dozens of lifecycle hooks. Explicitly reject designs containing unnecessary hooks:

```text
REJECTED — excessive lifecycle hooks:
    beforeApplicationCreate / afterApplicationCreate
    beforeRouterCreate / afterRouterCreate
    beforeRequest / afterRequest
    beforeResolve / afterResolve
    beforeRender / afterRender
    beforeSerialize / afterSerialize
    beforeHydrate / afterHydrate
    beforeDispose / afterDispose
```

Instead, Phase 0 derives the smallest lifecycle needed by:

1. The SEO built-in extension.
2. One realistic custom extension fixture.

A conceptual starting point (illustrative only — NOT frozen):

```ts
interface SsrExtension {
  name: string
  setup?(context: ExtensionContext): void
  resolve?(context: ExtensionContext): void | Promise<void>
  head?(context: ExtensionContext): HeadContribution | void
  client?(context: ExtensionContext): void
  dispose?(context: ExtensionContext): void
}
```

The final implementation may need fewer or different hooks.

> **Architectural Rule:** Add an extension lifecycle hook only when at least one real built-in or custom extension requires it.

### 3.10 Capability-Based Extension Context

Extensions receive a small, controlled `ExtensionContext` — **not** unrestricted mutable access to the entire SSR runtime.

**Reject:**

```ts
extension(runtime) {
  runtime.router = ...
  runtime.internalSomething = ...
  runtime.html = ...
}
```

**Instead, expose controlled capabilities (conceptual):**

```text
ExtensionContext
├── application
├── route
├── request
├── response
├── publicConfig
├── provide()
├── inject() / get()
├── registerResolution()
├── contributeHead()
└── registerEndpoint()
```

Only include capabilities actually needed by implementation. Do NOT expose private renderer/runtime internals merely for convenience. This creates a stable extension API while allowing `vue-ssr-lite` internals to evolve independently.

### 3.11 Request-Scoped Extension State

This is **mandatory** for SSR correctness.

**Extension Definition** — long-lived, immutable/configuration-oriented:

```text
seoExtension definition
    │
    ├── Request A
    │     └── SEO state A
    │
    └── Request B
          └── SEO state B
```

**Extension Request State** — created per SSR request, disposed after response.

Never allow patterns equivalent to:

```ts
let currentSeo = {}  // ❌ shared extension singleton
```

The architecture makes request-scoped state the default/easiest implementation model.

Concurrent requests must **never** leak between each other:

- SEO state
- Head data
- Dynamic origin
- Extension state
- Response state

### 3.12 Client-Side Extension State

Server request state and browser application state are distinct:

| Environment | Extension State Scope |
|---|---|
| **Server** | `extension definition → per-request extension scope` |
| **Client** | `extension definition → per-application extension scope` |

The SEO extension uses:

- **Server**: Request-scoped SEO store
- **Client**: Reactive application SEO store

without global cross-request state.

### 3.13 Extension Ordering

Ordering is simple and deterministic:

1. Core initializes.
2. Built-in extensions initialize.
3. Custom application extensions initialize.

Within custom extensions: **array declaration order**.

```ts
extensions: [
  extensionA(),  // runs before extensionB
  extensionB(),
]
```

Do **NOT** initially introduce:

- Numeric priorities
- Dependency graphs / topological sorting
- `before` / `after` declarations
- Extension scheduler

If a future concrete use case requires explicit dependencies, add that capability later.

### 3.14 Extension Registration

Simple internal registration flow:

```ts
function resolveExtensions(application) {
  return [
    ...resolveBuiltIns(application),
    ...application.extensions,
  ]
}
```

Built-ins are registered by `vue-ssr-lite` itself. Custom extensions follow them.

Do NOT create a complex registry/container unless implementation genuinely requires it.

### 3.15 Extension Identification

Each extension has a stable unique name:

```ts
defineExtension({
  name: 'company-auth',
  // ...
})
```

The runtime detects duplicate extension names in development and provides an actionable error/warning. Do not silently initialize the same extension twice.

### 3.16 Extension Errors

An extension error during SSR:

- Includes the extension name.
- Preserves the original error/cause.
- Flows through existing `vue-ssr-lite` error handling.
- Does **not** create a separate error framework.

Example diagnostic:

```text
[vue-ssr-lite] Extension "seo" failed during head resolution.
```

Do NOT create:

```text
ExtensionErrorBus
PluginFaultManager
RecoveryCoordinator
```

Reuse existing SSR error boundaries/runtime diagnostics.

### 3.17 Extension Cleanup

Extensions that allocate request/application resources must have a safe cleanup path:

- Subscriptions
- Timers
- Temporary request state
- Listeners

Cleanup integrates with existing request/application disposal. Do not create a separate extension resource lifecycle engine. Reuse the existing SSR lifetime boundaries.

### 3.18 Extension Access to Head

SEO requires head contribution. The design is generic enough that a custom extension may also contribute head items without becoming a second head manager.

**Correct:**

```text
extension → contribute to vue-ssr-lite managed head
```

**Incorrect:**

```text
extension → directly manipulate SSR HTML string
extension → independently mutate document.head with its own head manager
```

`vue-ssr-lite` is the **single authoritative head reconciliation system**. SEO is one producer of head state. Custom extensions contribute to the same managed head pipeline through a controlled capability.

### 3.19 Extension Access to Server Endpoints

SEO needs `/sitemap.xml` and `/robots.txt`. Endpoint contribution is a generic capability:

```ts
context.registerEndpoint(...)
```

SEO internally registers `/sitemap.xml` and `/robots.txt`. Future extensions may register other internal endpoints.

Important:

- Do NOT force endpoints into separate plugins.
- Do NOT expose the underlying server implementation directly.
- Endpoint registration reuses existing `vue-ssr-lite` endpoint routing/collision handling.

### 3.20 Extension Participation in SSR Settling

Extensions integrate with the existing SSR resolution lifecycle. SEO already needs the final settled page state.

Potential generic capability:

```ts
context.registerResolution(promise)
```

or the existing equivalent abstraction.

Do NOT build `ExtensionResolutionEngine` or `PluginPromiseRegistry` if the existing SSR runtime already provides resolution registration. Extensions consume the existing lifecycle.

### 3.21 Do NOT Expose Built-in SEO Extension Unnecessarily

The public API should **NOT** encourage:

```ts
seoExtension()
```

SEO implementation remains internal unless there is a concrete advanced reason to export it later.

Normal/public SEO API stays:

```ts
useSeo()
defineApplication({ seo: { ... } })
```

This prevents the internal architecture from leaking into application code.

### 3.22 Type Safety

The extension system is strongly typed:

- **Avoid**: `any`, `Record<string, any>`, arbitrary runtime mutation where a stable generic contract is possible.
- Extension configuration is inferable from the extension factory.
- Extension context capabilities have explicit types.
- Request state supports typed per-extension state.

However: Do NOT introduce a massive generic type system purely for type-level perfection. Prefer understandable TypeScript over clever conditional-type machinery.

### 3.23 Tree-Shaking & Bundle Behavior

- Built-in extensions necessary for the selected runtime/configuration are included.
- Optional built-in functionality does not force large unnecessary browser bundles.
- Server-only extension code (sitemap, robots endpoint, server database integrations) **never** leaks into browser bundles.
- The SEO extension has clear internal server/client boundaries.
- Hosted developers do not manually manage that split.

### 3.24 Extension Testability

Each built-in extension is independently testable against the extension contract.

SEO tests exercise:

- Extension registration
- Request isolation
- State creation
- SSR head contribution
- Client reconciliation
- Endpoint contribution
- Cleanup

Custom extension fixture proves external extension usage works without private imports.

### 3.25 Future Built-in Extension Example

A future feature can be added without modifying the core:

```text
src/extensions/
├── seo/
└── diagnostics/
```

Internally:

```ts
builtInExtensions = [
  seoExtension,
  diagnosticsExtension if configured,
]
```

Public API remains declarative:

```ts
defineApplication({
  diagnostics: {
    enabled: true,
  },
})
```

> **Scope Note:** Do NOT add diagnostics to the implementation scope. It is only an architecture proof example.

### 3.26 Custom Extension Example (Advanced)

> ⚠️ **ADVANCED** — This example is for Persona D (Platform Engineers) only. Do not include in Getting Started.

```ts
// src/extensions/request-id.ts
import { defineExtension } from 'vue-ssr-lite'

export const requestIdExtension = () =>
  defineExtension({
    name: 'request-id',

    setup(context) {
      // Use only documented extension capabilities.
    },
  })
```

Application:

```ts
import { requestIdExtension } from './extensions/request-id'

export default defineApplication({
  root: App,
  routes,

  extensions: [
    requestIdExtension(),
  ],
})
```

### 3.27 Anti-Overengineering Rules

The extension architecture **MUST NOT** initially contain:

```text
REJECTED PATTERNS:
├── PluginContainer / ExtensionContainer
├── DependencyInjectionContainer
├── EventBus
├── ExtensionScheduler
├── DependencyGraph / TopologicalSorter
├── Priority numbers
├── before/after dependency DSL
├── Extension marketplace
├── Runtime extension discovery from node_modules
├── Automatic filesystem plugin scanning
├── Extension manifest system
├── Extension sandbox VM
├── Hot extension reloading
├── Multiple head managers
├── Second SSR lifecycle
└── Second request lifecycle
```

Initial implementation should preferably be:

```text
ACCEPTED — minimal extension infrastructure:
├── Typed extension interface
├── defineExtension helper
├── Ordered extension list
├── Small ExtensionContext
├── Request-scoped state
├── Minimal required hooks
├── Built-in resolver
└── Custom application `extensions`
```

Nothing more unless a real requirement proves otherwise.

---

## 4. Hosted Application Structure & Server Boundaries

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

## 5. Universal Application Setup (`main.ts`)

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

A basic host application contains **zero** `extensions`, extension imports, extension configuration, or SSR-specific extension knowledge.

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

### Step 4: Advanced Custom Extensions (Persona D — Platform)

```ts
import { defineApplication } from 'vue-ssr-lite'
import App from './App.vue'
import { routes } from './routes'
import { createVLite } from 'vlite3'
import { requestIdExtension } from './extensions/request-id'

export default defineApplication({
  root: App,
  routes,

  plugins: [createVLite()],

  extensions: [
    requestIdExtension(),
  ],

  seo: {
    siteName: 'Builto',
  },
})
```

Vue `plugins` and `vue-ssr-lite` `extensions` coexist without ambiguity.

---

## 6. SEO as First Built-in Extension

The SEO functionality is designed internally as the **first built-in extension** — a DEFAULT-mode extension automatically attached with safe defaults.

```text
Core Runtime
     │
     └── SEO Extension
          ├── useSeo state integration
          ├── head rendering
          ├── canonical URLs
          ├── Open Graph
          ├── Twitter metadata
          ├── structured data
          ├── sitemap.xml
          └── robots.txt
```

**Important:** Do NOT split this into many tiny extensions:

```text
REJECTED — over-split extensions:
    HeadExtension
    CanonicalExtension
    OpenGraphExtension
    SitemapExtension
    RobotsExtension
    JsonLdExtension
```

Those capabilities are cohesive parts of **one SEO feature** and remain one built-in SEO extension. The internal implementation may use small modules/functions. The extension boundary exists at the **feature level**, not every file/function level.

### SEO Extension Mapping

The SEO extension is implemented entirely through the extension contract without adding SEO-specific hooks throughout core:

```text
seoExtension
    │
    ├── setup
    │    └── create request/client SEO state
    │
    ├── useSeo
    │    └── update SEO extension state
    │
    ├── settled SSR state
    │    └── normalize final SEO
    │
    ├── head contribution
    │    └── title/meta/canonical/social/JSON-LD
    │
    ├── endpoint contribution
    │    ├── sitemap.xml
    │    └── robots.txt
    │
    └── client integration
         └── reconcile managed head
```

If implementing SEO requires repeatedly bypassing the extension API and modifying unrelated core modules, treat that as evidence that the extension contract is missing a small generic capability. Do NOT respond by making SEO a special case everywhere.

### Normal Internal Composition Is Fine

The opposite rule is equally important. If the SEO implementation needs a simple internal helper, do not force it through an extension hook merely to claim "everything is a plugin."

For example:

- `seo/normalize.ts` can remain a normal function.
- `seo/sitemap.ts` can remain a normal internal module.

The extension boundary coordinates the feature with the core runtime. It does not replace normal software composition inside the feature.

---

## 7. Unified Public SEO Schemas & TypeScript Contracts

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

## 8. Universal `useSeo()`: Scoping, Lifecycle & Reactivity

### 8.1 Standard Page Usage (Automatic Canonical & Social Tags)

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

### 8.2 Advanced Overrides & Custom Tags (Escape Hatch)

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

### 8.3 Synchronous Registration & Internal Lifecycle

- **SSR**: `useSeo()` registers its contribution **synchronously during component `setup()`**. When the SSR request finishes rendering, the request scope is cleanly disposed.
- **Client**: `setup()` registers the contribution. When a component unmounts (`onUnmounted()`), its contribution is removed, restoring the parent/layout state.
- **`<KeepAlive>`**: Inactive components suspend their SEO contributions on `onDeactivated()` and restore them on `onActivated()`.
- **Precedence Hierarchy**: `APPLICATION < ROUTE < LAYOUT < PAGE < DESCENDANT COMPONENT`. (Developers simply call `useSeo()` in pages and optionally in layouts for defaults; the internal hierarchy manages resolution).

### 8.4 Reactivity & Participation in Existing SSR Settling

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

## 9. Head Tag Ownership Markers & Batched Reconciliation

### 9.1 Managed Ownership Attributes & Tag Identity

All tags generated by `vue-ssr-lite` are marked with `data-vue-ssr-lite-head`:

```html
<title data-vue-ssr-lite-head="title">About | Builto</title>
<meta name="description" content="..." data-vue-ssr-lite-head="description">
<link rel="canonical" href="..." data-vue-ssr-lite-head="canonical">
<meta property="og:title" content="..." data-vue-ssr-lite-head="og:title">
<meta name="twitter:card" content="..." data-vue-ssr-lite-head="twitter:card">
<script type="application/ld+json" data-vue-ssr-lite-head="json-ld">...</script>
```

### 9.2 Custom `meta[]` and `links[]` Identity Rules

- **Built-in Tags**: Identified by fixed library keys (`title`, `description`, `canonical`, `og:title`, etc.).
- **Custom Entries**:
  - If `key?: string` is provided, it serves as the explicit unique identity.
  - If `key` is omitted, identity is derived from primary attributes: `(name || property || httpEquiv) + ':' + content` for meta, and `rel + ':' + (hreflang || '') + ':' + (media || '') + ':' + href` for links.

### 9.3 Conflict Resolution with Pre-existing `index.html` Tags

- **Unrelated unmanaged tags** (favicons, font stylesheets, analytics scripts): **Never modified or deleted**.
- **Conflicting unmanaged SEO singleton tags** (e.g. static `<title>`, `<meta name="description">`, `<meta name="robots">`, `<link rel="canonical">` in `index.html`):
  - `vue-ssr-lite` managed SEO **supersedes** the static conflicting tag.
  - In development: emits a concise warning advising removal of the static duplicate.
  - In production: ensures exactly one authoritative tag exists in the DOM.

### 9.4 Batched Head Reconciliation on Navigation

On client-side route navigation (Page A ➔ Page B), the head reconciler calculates the final head snapshot and commits the DOM updates in a single batched pass. This prevents intermediate flashing of fallback/default titles or tags during page transitions.

### 9.5 Extension Head Contributions

Custom extensions may contribute to the managed head pipeline through the controlled `contributeHead()` capability. All head contributions — from the built-in SEO extension or custom extensions — flow through the same managed head system. `vue-ssr-lite` remains the single authoritative head reconciliation system regardless of how many extensions contribute head state.

---

## 10. Safe Public Origin & "One Deployment URL"

### 10.1 Resolution & Origin Normalization Invariant

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

### 10.2 Actionable Production Error Message

If an application with public SEO enabled is started in production without an authoritative origin, it fails immediately with a clear, concise diagnostic:

```text
[vue-ssr-lite] Missing PUBLIC_URL for production deployment.

Add:
PUBLIC_URL=https://example.com
```

### 10.3 Canonical Path Normalization

- **Query Parameters**: Stripped by default (`/about?utm_source=x` ➔ `https://builto.com/about`).
- **Hash Fragments**: Stripped by default (`/about#team` ➔ `https://builto.com/about`).
- **Trailing Slash Policy**: Normalized to no trailing slash by default (`/about/` ➔ `/about`), except root `/`. Configurable via `seo.trailingSlash`.

---

## 11. Route Metadata, HTTP 404 & Status Precedence

### 11.1 Route Definition

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

### 11.2 Safe 4xx/5xx Defaults & Precedence

- **Automatic Noindex**: Setting `meta.ssr.status = 404` (or calling `setResponseStatus(404)`) automatically implies `index: false` (`noindex`).
- **Status Precedence**: An effective HTTP 4xx/5xx status code overrides default page-level `index: true` settings, ensuring search engines never accidentally index error or not-found pages.

---

## 12. Sitemap Infrastructure (`/sitemap.xml`)

### 12.1 Static Route Discovery Rules

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

### 12.2 Server-Only Dynamic Sitemap (`sitemap.config.ts`)

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

### 12.3 Deterministic File Collision Policy

- If a physical `public/sitemap.xml` exists, the physical static file wins and the dynamic generator is disabled.
- If a physical `public/robots.txt` exists, the physical static file wins and the dynamic generator is disabled.

---

## 13. `robots.txt` Endpoint (`/robots.txt`)

### 13.1 Default Output

`vue-ssr-lite` automatically serves `/robots.txt`:

```text
User-agent: *
Allow: /

Sitemap: https://builto.com/sitemap.xml
```

### 13.2 Custom Disallow Rules

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

## 14. Structured Data Support (JSON-LD)

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

## 15. Runtime Configuration Transport & Security (`usePublicConfig<T>`) — Level 2

Safe server-to-client configuration transport without application context boilerplate:

### 15.1 Serialization Security Invariants

- `publicConfig` **must contain browser-safe data only**.
- `vue-ssr-lite` secures the serialized hydration payload:
  - Strings containing `</script>`, `<`, `>`, `&`, `\u2028`, and `\u2029` are safely escaped (e.g. `\u003C/script\u003E`).
  - Functions, symbols, cyclic references, and non-serializable objects are rejected with clear diagnostics.

### 15.2 Usage

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

## 16. Platform Infrastructure (`ssr.config.ts`) — Level 3

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

## 17. Coexistence with `vlite3` (One App = One Head Manager)

- **`vue-ssr-lite` Applications**:  
  Developers use `import { useSeo } from 'vue-ssr-lite'`. `vue-ssr-lite` is the sole authoritative head manager. `<SeoProvider>` is removed.
- **Standalone SPA `vlite3` Applications**:  
  `vlite3` retains its own independent SPA SEO system.
- **No Competing Head Managers**: `vue-ssr-lite` does not execute complex runtime arbitration; applications use the native `vue-ssr-lite` import.

---

## 18. Complete Responsibility Matrix

| Capability | `vue-ssr-lite` | Hosted Application | `vlite3` |
|---|:---:|:---:|:---:|
| `createSSRApp()` / `createApp()` lifecycle | **OWNS** | — | — |
| Request isolation & context management | **OWNS** | — | — |
| `renderToString()` & hydration execution | **OWNS** | — | — |
| Extension runtime | **OWNS** | — | — |
| Built-in SEO extension | **OWNS** | — | — |
| Built-in extension auto-registration | **OWNS** | — | — |
| Built-in extension configuration | **OWNS** (public application config) | — | — |
| Request-scoped extension state | **OWNS** | — | — |
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
| Custom extension implementation | — | **OWNS** | — |
| Custom extension registration | — | **OWNS** (through `extensions`) | — |
| Structured data business schema content | — | **OWNS** | Optional schema helpers |
| Page titles, descriptions, social images | — | **OWNS** | — |
| Global site branding & default SEO | — | **OWNS** | — |
| UI Component library | — | — | **OWNS** |

---

## 19. Internal Module Structure

`vue-ssr-lite` organizes core, extension infrastructure, built-in extensions, and server capabilities in separated internal modules:

```text
src/
├── core/
│   ├── application/        <── Application definition/resolution
│   ├── runtime/            <── SSR runtime, request context, publicConfig transport
│   ├── rendering/          <── renderToString, HTML serialization
│   ├── router/             <── Router creation, history handling
│   ├── hydration/          <── Browser hydration
│   │
│   └── extensions/         <── Extension infrastructure (part of core)
│       ├── Extension.ts         <── Extension interface/types
│       ├── ExtensionContext.ts  <── Capability-based context
│       ├── ExtensionRuntime.ts  <── Resolution, ordering, lifecycle execution
│       └── defineExtension.ts   <── Typed extension factory helper
│
├── extensions/             <── Built-in feature extensions (≠ core infrastructure)
│   └── seo/
│       ├── index.ts        <── SEO extension entry point
│       ├── types.ts        <── SeoInput, UseSeoInput, SeoApplicationConfig
│       ├── state.ts        <── Request-scoped and client SEO state store
│       ├── normalize.ts    <── SEO property derivation & social card propagation
│       ├── server.ts       <── SSR HTML <head> tag generation & JSON-LD escaping
│       ├── client.ts       <── Batched browser DOM head reconciliation & KeepAlive
│       ├── sitemap.ts      <── Static discovery, sitemap.config.ts runner, XML generator
│       └── robots.ts       <── robots.txt endpoint handler
│
└── server/
    └── ...                 <── Existing server/platform infrastructure, origin resolution
```

> **Important separation:** `core/extensions/` contains the extension infrastructure (part of core). `extensions/` contains built-in feature extensions implemented using that infrastructure. These are not the same thing.

> **Note:** Before committing exact paths, align them with the repository's existing structure and naming conventions. Do NOT reorganize unrelated working code merely to match this diagram.

---

## 20. Phased Implementation Plan

```text
PHASE 0: Public API + Extension Contract Freeze
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
├── Freeze canonical dynamic sitemap file (sitemap.config.ts)
├── Freeze plugins vs extensions terminology distinction
├── Freeze defineExtension() helper signature
├── Freeze minimal extension lifecycle (derive from SEO requirements)
├── Freeze ExtensionContext capabilities
├── Freeze request-scoped state model
├── Freeze extension ordering (built-in first, then custom in array order)
├── Freeze built-in vs custom extension behavior
├── Freeze extension error handling (name + cause through existing SSR errors)
└── Freeze server/client extension boundaries

PHASE 1: Minimal Core Extension Runtime
├── Implement typed extension interface (SsrExtension)
├── Implement defineExtension() factory helper
├── Implement ExtensionContext with controlled capabilities
├── Implement resolveExtensions() (built-in + custom registration)
├── Implement request-scoped extension state creation/disposal
├── Implement client-scoped extension state lifecycle
├── Implement extension ordering (built-in → custom, array order)
├── Implement duplicate extension name detection (dev diagnostics)
└── Implement extension error wrapping (name + cause)

PHASE 2: Core SEO Types & State Store (First Built-in Extension)
├── Implement SEO as built-in DEFAULT extension using extension contract
├── Implement request-scoped SEO store for SSR
└── Implement reactive client-scoped SEO store with synchronous setup() registration

PHASE 3: useSeo() Composable & Reactivity
├── Implement useSeo() accepting UseSeoInput (Ref, ComputedRef, getters)
├── Implement onUnmounted() contribution cleanup
├── Implement onActivated() / onDeactivated() for <KeepAlive> support
└── Connect to existing SSR settling point (async setup / Suspense)

PHASE 4: SSR Head Rendering & Batched Browser Reconciliation
├── Implement SSR head tag serializer with data-vue-ssr-lite-head markers
├── Implement batched browser DOM head reconciler with custom tag key/tuple identity
├── Implement conflicting static tag superseding with dev warning
├── Implement extension head contribution pipeline (contributeHead capability)
└── Add JSON-LD script breakout protection (\u003C/script\u003E)

PHASE 5: Authoritative Origin Resolution & Canonical Path Normalization
├── Implement server-side siteUrl resolution (PUBLIC_URL fallback with origin validation)
├── Implement production fail-fast validator with concise error message
├── Implement automatic current-route canonical URL derivation
└── Implement canonical path normalizer (strip queries/hashes, trailing slash policy)

PHASE 6: Route Metadata Contracts & HTTP Statuses
├── Export RouteMeta TypeScript module augmentation
├── Implement status code handler (setResponseStatus and meta.ssr.status)
└── Connect HTTP 4xx/5xx statuses to automatic noindex defaults and precedence

PHASE 7: Static Sitemap & Robots.txt Infrastructure (via Extension Endpoints)
├── Implement static route discovery engine from Vue Router tree (handling pathless parents)
├── Implement XML sitemap serializer, caching headers & physical file collision checks
├── Implement /robots.txt endpoint with standard defaults and physical file collision checks
└── Implement endpoint registration through extension context (registerEndpoint capability)

PHASE 8: Server-Only Dynamic Sitemap Extension
├── Implement defineSitemap helper with SitemapContext in vue-ssr-lite/server
└── Connect dynamic sitemap provider (sitemap.config.ts) to /sitemap.xml endpoint

PHASE 9: usePublicConfig<T>() Transport Cleanup & Serialization Security
├── Implement safe server-to-client configuration serializer with script breakout protection
└── Expose universal usePublicConfig<T>() composable

PHASE 10: Custom Extension Fixture & External Extension API Validation
├── Add fixtures/advanced-consumer/ with extensions: [testExtension()]
├── Validate extension setup, typed context, request state, SSR participation
├── Validate client-side extension participation
└── Validate custom extension works without private imports

PHASE 11: Builto Landing Migration & Cleanup
├── Update Builto Landing to use new defineApplication() and useSeo()
└── Delete legacy files (LandingSsrContext, PublicSsrSeo, PublicSiteOrigin, etc.)

PHASE 12: Comprehensive Test Suite & Production Verification
└── Execute full verification test matrix across SSR, Client, Extensions, Sitemap, DX, and Security
```

---

## 21. Validation & Verification Test Matrix

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
| **Extension / DX** | Basic consumer has zero `extensions` configuration | `fixtures/basic-consumer/` contains no `extensions` property |
| **Extension / DX** | Built-in SEO works automatically | SEO functions without explicit extension registration |
| **Extension / DX** | `useSeo()` works without importing SEO extension | Normal API, not extension API |
| **Extension / DX** | Custom extension via `extensions` | Custom extension passed through `extensions: [...]` initializes correctly |
| **Extension / DX** | Vue `plugins` and `extensions` coexist | No ambiguity or collision between Vue plugins and SSR extensions |
| **Extension Isolation** | Two concurrent requests, same extension definition | Different request state for each request |
| **Extension Isolation** | Built-in SEO concurrent isolation | Head state does not leak between concurrent SSR requests |
| **Extension Isolation** | Custom extension request isolation | Custom extension cannot receive another request's scoped state through standard APIs |
| **Extension Ordering** | Built-in extension setup | Occurs deterministically before custom extensions |
| **Extension Ordering** | Custom extension array order | Declaration order is preserved |
| **Extension Ordering** | Duplicate extension names | Produces actionable development diagnostic |
| **Extension Boundary** | Server-only extension modules | Never enter client build |
| **Extension Boundary** | Client-side extension lifecycle | Works correctly after hydration |
| **Extension Errors** | Extension error during SSR | Includes extension identity and flows through existing SSR error handling |
| **Extension Cleanup** | Request-scoped extension state after response | Released after response is sent |
| **Extension Cleanup** | Client extension resources on dispose | Released when application/runtime is disposed |
| **Extension Head** | Custom extension contributes head | Supported through `contributeHead` capability without replacing core head manager |
| **Extension Endpoints** | Custom extension registers endpoint | Supported through `registerEndpoint` capability without replacing core server routing |
| **Basic Fixture** | `fixtures/basic-consumer/` | Basic zero-config app runs with zero SSR/extension glue code |
| **Advanced Fixture**| `fixtures/advanced-consumer/` | Advanced app tests `publicConfig`, dynamic sitemap, custom extension, multi-app context, custom head |
| **Production**| Full build & start (`builto-landing`) | Production build runs with zero SSR glue code |

---

## 22. Fixture Design

### `fixtures/basic-consumer/`

Completely **extension-free**. Proves:

```ts
export default defineApplication({
  root: App,
  routes,
})
```

Contains **zero**:

- `extensions`
- Extension imports
- Extension configuration
- SSR-specific extension knowledge

### `fixtures/advanced-consumer/`

Demonstrates custom extension usage:

```ts
import { testExtension } from './extensions/test-extension'

export default defineApplication({
  root: App,
  routes,

  extensions: [
    testExtension(),
  ],
})
```

Proves:

- Extension setup with typed context
- Request-scoped state per extension
- SSR participation
- Client participation if relevant
- Works without private imports

> **Do NOT** make the advanced fixture the documentation baseline.

---

## 23. Builto Landing Target End-State & Acceptance Criteria

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
- [ ] `src/main.ts` contains zero `extensions` configuration (SEO is auto-attached).
- [ ] SEO works through declarative `seo: { ... }` configuration, not explicit extension registration.
- [ ] Vue `plugins` and `vue-ssr-lite` `extensions` are not conflated.
- [ ] No extension imports appear in application code.
- [ ] Builto Landing ends with zero SSR/SEO glue and zero extension knowledge.
