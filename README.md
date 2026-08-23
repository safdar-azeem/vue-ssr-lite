# vue-ssr-lite

Convention-first SSR for Vue 3 and Vite that scales from one normal Vue app to
many independent applications in one repository. A website, admin, dashboard,
shop, or customer portal can each choose SSR or SPA and be selected by domain
or subdomain—without separate repositories or manual server/browser bootstraps.
`vue-ssr-lite` owns the unified runtime, host routing, router history,
hydration, request isolation, and Node lifecycle while your applications remain
normal Vue applications.

## Install

```bash
yarn add vue-ssr-lite
```

or:

```bash
npm install vue-ssr-lite
```

`vue-ssr-lite` is designed to be added to an existing Vue 3 + Vite
application. It uses the application's existing Vue and Vite installation; no
separate `@vue/server-renderer` installation is required. `vue-router` is
provided by `vue-ssr-lite` for the simple `routes` API because the runtime
creates that router. If application code directly imports Vue Router APIs for
the advanced router factory below, keep `vue-router` as a direct dependency of
the host application (existing routed applications should keep their current
dependency).

Requires Node.js 20 or newer.

## One repo, one app or many

Start with the zero-config path when the repository contains one application.
When a product grows, add `applications` to keep multiple independently routed
Vue applications in the same codebase:

```text
my-platform/
├── src/
│   ├── website/main.ts       → example.com       → SSR
│   ├── admin/main.ts         → admin.example.com → SPA
│   ├── shop/main.ts          → shop.example.com  → SSR
│   └── dashboard/main.ts     → app.example.com   → SPA
├── index.html
├── ssr.config.ts
├── vite.config.ts
└── package.json
```

One unified `vue-ssr-lite` runtime/server selects the application from the
incoming host; different subdomains do not require separate repositories or
separate SSR implementations:

```text
one repository → vue-ssr-lite runtime
  example.com       → website   → SSR
  admin.example.com → admin     → SPA
  shop.example.com  → shop      → SSR
  app.example.com   → dashboard → SPA
```

## Zero-config single application

Start with the structure Vite already gives you:

```text
my-vue-app/
├── src/
│   ├── main.ts
│   ├── App.vue
│   ├── router/
│   └── ...
├── index.html
├── vite.config.ts
└── package.json
```

Rewrite the existing browser bootstrap as a universal application definition:

```ts
// src/main.ts
import { defineApplication } from 'vue-ssr-lite'
import App from './App.vue'
import routes from './router/routes'

export default defineApplication({
  root: App,
  routes,
})
```

The application definition describes the Vue application. The runtime chooses
`createSSRApp`, request-safe memory history, web history, hydration, and plugin
installation for the active environment. Do not call `createApp().mount()` in
this file.

The normal Vite integration is one plugin line:

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vueSsrLite } from 'vue-ssr-lite/vite'

export default defineConfig({
  plugins: [vue(), vueSsrLite()],
})
```

There is no `ssr.config.ts`, `app.ts`, `entry-client.ts`, `entry-server.ts`,
`site.html`, duplicate application ID, manual hydration, or explicit domain
configuration in this path. Add the normal lifecycle scripts:

```json
{
  "scripts": {
    "dev": "vue-ssr-lite dev",
    "build": "vue-ssr-lite build",
    "start": "vue-ssr-lite start"
  }
}
```

The defaults are:

| Concern | Convention |
| --- | --- |
| Application | `./src/main.ts` |
| HTML template | `./index.html` |
| Mount target | `#app` |
| Render mode | `ssr` |
| Single-app host | incoming `Host` header (`*`) |
| Server port | `PORT`, then the library default |
| Runtime role | `unified` |

## Existing `index.html` stays yours

Keep the existing Vite HTML, including metadata, favicon links, styles,
analytics, verification tags, and unrelated module scripts:

```html
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
  <script type="module" src="/analytics.ts"></script>
</body>
```

The plugin replaces only the configured application bootstrap and preserves the
other module scripts. It adds the generated hydration entry and the internal
SSR markers without requiring a second HTML file.

## Optional `ssr.config.ts` overrides

Configuration is an override layer. Unspecified values continue to use the
conventions above.

Custom application entry:

```ts
import { defineSsrConfig } from 'vue-ssr-lite'

export default defineSsrConfig({
  app: './src/platform/main.ts',
})
```

Custom template or mount target:

```ts
export default defineSsrConfig({
  template: './website.html',
  mount: '#website',
})
```

Flat advanced single-app options stay flat:

```ts
export default defineSsrConfig({
  server: {
    trustProxy: true,
  },
  publicConfig: {
    apiUrl: process.env.API_URL,
  },
  cookies: {
    allow: ['session'],
  },
})
```

Do not put single-application fields beside `applications`. Mixed configuration
is rejected early; move the field into the relevant application entry instead.

## Plugins and advanced routers

Use a plugin factory for stateful integrations so each SSR request receives a
fresh Pinia, i18n, Apollo, or other request-sensitive instance:

```ts
export default defineApplication({
  root: App,
  routes,
  plugins: () => [
    createPinia(),
    createI18n(),
    createApollo(),
  ],
})
```

Stateless global-safe plugin arrays remain supported. For mature router setups,
the library supplies the environment-appropriate history while the application
keeps ownership of router options. If this factory directly imports
`createRouter` or other Vue Router APIs, the host application must declare
`vue-router` as a direct dependency; do not rely on another package's
transitive dependency under strict/non-hoisting package managers:

```ts
import { createRouter } from 'vue-router'

export default defineApplication({
  root: App,
  router: ({ history }) => createRouter({
    history,
    routes,
    scrollBehavior,
  }),
})
```

`routes` and `router` are mutually exclusive. Router-less applications do not
create Vue Router history at all.

## Multi-application projects

Multi-app mode is for products where several Vue applications live in the same
repository. They can share components, packages, types, services, and
infrastructure while keeping independent roots, routes, rendering modes,
templates, and host routing. Introduce `applications` only when there are
actually multiple applications; a single app does not need this configuration.
Each object key is the canonical application ID; do not repeat it in
`src/*/main.ts`.

```ts
import { defineSsrConfig } from 'vue-ssr-lite'

export default defineSsrConfig({
  applications: {
    website: {
      app: './src/website/main.ts',
      host: 'example.com',
    },
    admin: {
      app: './src/admin/main.ts',
      render: 'spa',
      host: 'admin.example.com',
    },
    shop: {
      app: './src/shop/main.ts',
      host: 'shop.example.com',
    },
    dashboard: {
      app: './src/dashboard/main.ts',
      render: 'spa',
      host: 'app.example.com',
    },
  },
})
```

Omitted `render` means SSR, so `website` and `shop` are SSR applications while
`admin` and `dashboard` are SPAs. Rendering mode belongs to each application;
one SPA does not change the mode of the others. Each application module
default-exports `defineApplication(...)`:

```ts
// src/website/main.ts
import { defineApplication } from 'vue-ssr-lite'
import App from './App.vue'

export default defineApplication({
  root: App,
})
```

For application host routing, use exact hosts such as `example.com`,
subdomains such as `admin.example.com`, wildcard hosts such as
`*.shop.example.com`, or the advanced `domain` options. Host specificity
determines the winner; duplicate ownership and ambiguous routing fail during
startup.

## Advanced capabilities

The normalized runtime still supports roles, domains and subdomains,
`publicConfig`, cookies, endpoints, response caching, readiness probes,
diagnostics, metrics, redirects, status codes, and proxy-aware host handling.
These belong in optional configuration and application code rather than in the
normal consumer bootstrap.

Request context and domain context are available to advanced integrations:

```ts
import { useSsrDomain, useSsrRequestContext } from 'vue-ssr-lite'

const domain = useSsrDomain()
const request = useSsrRequestContext()
```

`publicConfig` is opaque and browser-safe; validate API URLs and integration
details in the consuming application or plugin.

## Failure messages

Convention discovery fails early with actionable guidance when `src/main.ts`,
`index.html`, or the configured mount target is missing. The compiler also
reports invalid application exports, mixed single-/multi-app configuration, and
unresolved multi-app host routing before the server handles traffic.

## Package entry points

| Import | Purpose |
| --- | --- |
| `vue-ssr-lite` | `defineApplication`, `defineSsrConfig`, request/domain context |
| `vue-ssr-lite/client` | Internal browser hydration and SPA mounting |
| `vue-ssr-lite/server` | Managed server, compilation, host matching, endpoints |
| `vue-ssr-lite/vite` | Vite HTML and generated client/server entry integration |

## License

MIT
