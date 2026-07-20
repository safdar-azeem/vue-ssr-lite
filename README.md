# vue-ssr-lite

A simple, production-ready SSR runtime for Vue 3 and Vite.

Use it to run:

- A server-rendered Vue website
- A normal Vue SPA
- Multiple SSR applications
- SPA and SSR applications together
- Applications on different domains or subdomains

It includes routing, browser hydration, production builds, a managed Node server, health checks, custom endpoints, caching, timeouts, and Vue plugin support.

## Features

- Vue 3 server-side rendering
- Normal Vue SPA support
- SPA and SSR in one project
- Vue Router support
- Automatic browser hydration
- Multiple applications and HTML entries
- Domain and subdomain routing
- Runtime roles for one image / many process modes
- Generic `publicConfig` transport (Apollo, REST, Pinia, i18n stay in the app)
- SEO metadata and status codes
- Custom server endpoints
- Health and readiness checks
- Request timeouts
- Optional response caching
- Cookie allow / deny filtering (including deny-only)
- Proxy-aware host and protocol resolution
- Graceful shutdown
- TypeScript support

## Package Entry Points

| Import | Purpose |
| --- | --- |
| `vue-ssr-lite` | `defineSsrConfig`, `defineSsrApplication`, `useSsrDomain`, request context |
| `vue-ssr-lite/client` | Browser hydration and SPA mount |
| `vue-ssr-lite/server` | Managed Node server, config compile, host matching, cookies |
| `vue-ssr-lite/vite` | Vite plugin that wires HTML templates and virtual client entries |

CLI binary (auto-discovers `ssr.config.ts|.mts|.js|.mjs` in the project root):

```bash
vue-ssr-lite <dev|build|start> [--root .] [--config ssr.config.ts] [--server-output dist/server/SsrRuntime.js] [--hmr-port 31001]
```

Requires Node.js 20 or newer.

Development servers use an operating-system-assigned HMR WebSocket port, so
multiple `vue-ssr-lite dev` processes can run concurrently. Use `--hmr-port`
or `VUE_SSR_LITE_HMR_PORT` when a proxy or container requires a fixed port.

## Installation

```bash
npm install vue-ssr-lite vue vue-router @vue/server-renderer
npm install --save-dev vite @vitejs/plugin-vue
```

Using Yarn:

```bash
yarn add vue-ssr-lite vue vue-router @vue/server-renderer
yarn add --dev vite @vitejs/plugin-vue
```

## Clean consumer (canonical path)

Every project follows the same five pieces. `ssr.config` is the single source of
truth — there is no `spaEntries`, no `kind`, no manual `main.ts` mount, and no
`server.role`.

| Piece | Role |
| --- | --- |
| `ssr.config.ts` | Apps, domains, `runtime`, cookies, endpoints |
| `defineSsrApplication()` modules | One module per app (`application.module`) |
| HTML shells | Mount node only — **no** bootstrap `<script type="module" src>` |
| `vite.config.ts` | `vue()` + `vueSsrLite()` |
| CLI scripts | `vue-ssr-lite dev \| build \| start` |

Render modes (declared as `render` on each application):

| `render` | Behavior |
| --- | --- |
| `spa` | Serves the HTML shell; the plugin generates the browser mount entry |
| `ssr` | Server-renders Vue and generates the hydration client entry |

`vueSsrLite()` defaults the client Vite `build.outDir` to `dist/client` so
`vue-ssr-lite start` finds assets without a consumer override. Set
`build.outDir` or `server.clientOutDir` only when you need a different path.

Production compile requires top-level `runtime` (typically `APP_RUNTIME`) and
each app’s `domain.production`. `publicConfig` is opaque — validating API URLs
is the consumer’s job.

For async config, export a factory that *returns* `defineSsrConfig(...)`:

```ts
export default async () =>
  defineSsrConfig({
    name: 'my-platform',
    runtime: process.env.APP_RUNTIME,
    applications: { /* ... */ },
  })
```

`defineSsrConfig` itself is synchronous and accepts a plain object.

See `fixtures/clean-consumer` in this repo for a minimal SPA project that
matches this contract.

## Quick Start: SPA and SSR Together

The following example creates:

- A dashboard SPA on `app.example.com`
- A server-rendered website on all other hosts

## 1. Create the SPA Application

Define the application once. The library owns router creation, plugin
installation, public-config delivery, and mounting via the generated virtual
client — do **not** add a `main.ts` bootstrap.

```ts
// src/dashboard/DashboardBootstrap.ts
import { defineSsrApplication } from 'vue-ssr-lite'
import App from './App.vue'
import routes from './routes'

export const createDashboardApplication = defineSsrApplication({
  id: 'dashboard',
  rootComponent: App,
  routes,
  plugins: [/* your Vue plugins */],
})
```

Create the SPA root component:

```vue
<!-- src/dashboard/App.vue -->
<script setup lang="ts">
import { RouterView } from 'vue-router'
</script>

<template>
	<RouterView />
</template>
```

Create the SPA HTML shell (no bootstrap script):

```html
<!-- index.html -->
<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta
			name="viewport"
			content="width=device-width, initial-scale=1" />
		<title>Dashboard</title>
	</head>

	<body>
		<div id="app"></div>
	</body>
</html>
```

## 2. Create the SSR Application

Create the SSR root component:

```vue
<!-- src/website/App.vue -->
<script setup lang="ts">
import { RouterView } from 'vue-router'
</script>

<template>
	<RouterView />
</template>
```

Create the SSR routes:

```ts
// src/website/routes.ts
import type { RouteRecordRaw } from 'vue-router'

import HomePage from './pages/HomePage.vue'
import AboutPage from './pages/AboutPage.vue'
import NotFoundPage from './pages/NotFoundPage.vue'

export const websiteRoutes: RouteRecordRaw[] = [
	{
		path: '/',
		component: HomePage,
	},
	{
		path: '/about',
		component: AboutPage,
	},
	{
		path: '/:pathMatch(.*)*',
		component: NotFoundPage,
	},
]
```

Define the SSR application:

```ts
// src/website/SsrApplication.ts
import { defineSsrApplication } from 'vue-ssr-lite'

import App from './App.vue'
import { websiteRoutes } from './routes'

export const websiteApplication = defineSsrApplication({
	id: 'website',
	rootComponent: App,
	routes: websiteRoutes,
})
```

Create its HTML template:

```html
<!-- site.html -->
<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta
			name="viewport"
			content="width=device-width, initial-scale=1" />
	</head>

	<body>
		<div id="app"></div>
	</body>
</html>
```

The SSR browser entry and hydration setup are added automatically.

## 3. Create `ssr.config.ts`

Every application is one self-contained object: runtime, domain, GraphQL,
cookies, endpoints, and roles. The library expands domains, matches hosts by
specificity, and exposes context through `useSsrDomain()`.

```ts
// ssr.config.ts — the only application / domain registration source
import { defineSsrConfig } from 'vue-ssr-lite'

export default defineSsrConfig({
	name: 'my-platform',
	runtime: process.env.APP_RUNTIME, // required in production
	server: {
		host: '0.0.0.0',
		port: Number(process.env.PORT || 4173),
		trustProxy: true,
	},
	applications: {
		dashboard: {
			render: 'spa',
			application: {
				module: './src/dashboard/DashboardBootstrap.ts',
				exportName: 'createDashboardApplication',
			},
			template: 'index.html',
			roles: ['unified', 'dashboard'],
			domain: {
				development: 'localhost',
				production: process.env.VITE_ROOT_DOMAIN!,
				mode: 'root-and-subdomains',
				localAliases: true,
				params: {
					workspace: { source: 'last-subdomain-label' },
				},
			},
			publicConfig: {
				api: {
					endpoint: process.env.VITE_GRAPHQL_ENDPOINT!,
					timeout: 8_000,
				},
			},
		},
		website: {
			render: 'ssr',
			application: {
				module: './src/website/SsrApplication.ts',
				exportName: 'websiteApplication',
			},
			template: 'site.html',
			roles: ['unified', 'website'],
			domain: {
				development: 'shop.localhost',
				production: process.env.VITE_SHOP_BASE_DOMAIN!,
				mode: 'root-and-subdomains',
				customDomains: true,
				params: {
					storeDomain: { source: 'subdomain-or-hostname' },
				},
			},
			publicConfig: {
				api: {
					endpoint: process.env.VITE_GRAPHQL_ENDPOINT!,
					timeout: 8_000,
				},
			},
		},
	},
})
```

The object key under `applications` is the canonical application ID everywhere
(routing, Apollo `applicationId`, hydration state).

Host ownership is resolved by **specificity**, not application declaration order:

1. Exact hostname
2. Longest matching wildcard suffix (for example `*.shop.example.com` beats `*.example.com`)
3. Shorter matching wildcard suffix
4. Catch-all `*` (from `customDomains: true`)
5. `defaultApplicationId` when no host pattern matches

Overlapping wildcards are valid. Duplicate exact or identical wildcard patterns across applications are rejected at startup.

When the server starts, the console prints a ready message with a clickable local URL and the active role:

```text
✓  Server Ready

  ➜ Local:  http://localhost:4173/
  ➜ Role:   unified
```

## 4. Configure Vite

Keep Vite-only concerns here (Vue, CSS, codegen, aliases). Application wiring
stays in `ssr.config.ts`:

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vueSsrLite } from 'vue-ssr-lite/vite'

export default defineConfig({
	plugins: [
		vueSsrLite(),
		vue(),
	],
})
```

`vueSsrLite()` generates:

- HTML Rollup inputs from each `template`
- Client `build.outDir` defaulting to `dist/client` (aligned with the Node server)
- `virtual:vue-ssr-lite/client/<id>` SPA mount / SSR hydrate entries
- `virtual:vue-ssr-lite/runtime` for the Node server (SSR apps only; SPA modules are omitted)

HTML templates should not include a manual `<script type="module" src="...">`
bootstrap — the plugin strips those tags from matched templates and injects the
generated client entry. Editing `ssr.config.*` invalidates the cached config and
triggers a full reload in dev.

## 5. Add Commands

```json
{
	"scripts": {
		"dev": "vue-ssr-lite dev",
		"build": "vue-ssr-lite build",
		"start": "vue-ssr-lite start"
	}
}
```

## 6. Start Development

```bash
npm run dev
```

Build and run production:

```bash
npm run build
npm run start
```

## SSR-Only Application

```ts
export default defineSsrConfig({
	name: 'my-website',
	runtime: process.env.APP_RUNTIME,
	applications: {
		website: {
			render: 'ssr',
			application: {
				module: './src/website/SsrApplication.ts',
				exportName: 'websiteApplication',
			},
			template: 'site.html',
			domain: {
				development: 'localhost',
				production: process.env.VITE_ROOT_DOMAIN!,
				customDomains: true,
			},
			publicConfig: {
				api: { endpoint: process.env.VITE_API_ENDPOINT!, timeout: 8_000 },
			},
		},
	},
})
```

## SPA-Only Application

```ts
export default defineSsrConfig({
	name: 'my-dashboard',
	runtime: process.env.APP_RUNTIME,
	applications: {
		dashboard: {
			render: 'spa',
			application: {
				module: './src/dashboard/DashboardBootstrap.ts',
				exportName: 'createDashboardApplication',
			},
			template: 'index.html',
			domain: {
				development: 'localhost',
				production: process.env.VITE_ROOT_DOMAIN!,
				localAliases: true,
			},
			publicConfig: {
				api: { endpoint: process.env.VITE_API_ENDPOINT!, timeout: 8_000 },
			},
		},
	},
})
```

The library generates the SPA client entry from `application.module`. Keep
`index.html` free of manual bootstrap scripts.

## Using the Same Vue Plugins

Plugins read opaque `publicConfig` — the library does not know about GraphQL:

```ts
// src/config/apollo.ts
import { defineApollo } from 'vue-apollo-client'

export default defineApollo(({ publicConfig }) => ({
	endPoints: {
		default: publicConfig?.api?.endpoint,
	},
	requestTimeoutMs: publicConfig?.api?.timeout,
}))
```

Use the same configuration in SSR:

```ts
// src/website/SsrApplication.ts
import { defineSsrApplication } from 'vue-ssr-lite'

import apollo from '../config/apollo'
import App from './App.vue'
import { websiteRoutes } from './routes'

export const websiteApplication = defineSsrApplication({
	id: 'website',
	rootComponent: App,
	routes: websiteRoutes,
	plugins: [apollo],
})
```

This allows one plugin configuration to support both application types.

You can use the same approach with:

- Apollo and GraphQL
- Pinia
- i18n
- Theme providers
- REST clients
- Authentication plugins
- Analytics plugins
- Custom Vue plugins

## Using GraphQL in SSR

Keep GraphQL operations in `.graphql` files:

```graphql
query GetPosts {
	posts {
		id
		title
	}
}
```

Use the generated composable in the Vue page:

```vue
<script setup lang="ts">
import { useGetPostsQuery } from '../graphql'

const { result, loading, error } = useGetPostsQuery(
	{},
	{
		ssr: true,
		fetchPolicy: 'cache-first',
	},
)
</script>

<template>
	<main>
		<p v-if="loading">Loading...</p>

		<p v-else-if="error">
			{{ error.message }}
		</p>

		<article
			v-for="post in result?.posts ?? []"
			:key="post.id">
			<h2>{{ post.title }}</h2>
		</article>
	</main>
</template>
```

The same generated composable can also be used inside the SPA.

Use `ssr: true` for public data that should be included in server-rendered HTML.

Use `ssr: false` for browser-only or private queries.

## Using REST APIs

REST APIs can be used through:

- Native `fetch`
- Axios
- Ky
- A custom Vue plugin
- Another SSR-compatible data package

Example:

```vue
<script setup lang="ts">
import { onServerPrefetch, ref } from 'vue'

interface Post {
	id: string
	title: string
}

const posts = ref<Post[]>([])

const loadPosts = async () => {
	const response = await fetch('https://api.example.com/posts')

	posts.value = await response.json()
}

onServerPrefetch(loadPosts)
</script>

<template>
	<article
		v-for="post in posts"
		:key="post.id">
		<h2>{{ post.title }}</h2>
	</article>
</template>
```

For reusable REST caching and hydration, register an SSR-compatible Vue plugin in the `plugins` array.

## Public Configuration

Pass opaque, browser-safe values per application in `ssr.config`:

```ts
applications: {
  website: {
    // ...
    publicConfig: {
      apiUrl: 'https://api.example.com',
      graphqlEndpoint: 'https://api.example.com/graphql',
    },
  },
}
```

Access them in a component:

```ts
import { useSsrRequestContext } from 'vue-ssr-lite'

const context = useSsrRequestContext()
const apiUrl = context.publicConfig.apiUrl
```

The library does not interpret `publicConfig` (no GraphQL/REST assumptions).
Validate transport URLs in your own plugins or env checks.

## SEO

Set page metadata from a component:

```ts
import { useSsrRequestContext } from 'vue-ssr-lite'

const context = useSsrRequestContext()

context.head.value = {
	title: 'Products',
	description: 'Browse our latest products.',
	robots: 'index, follow',
	canonicalUrl: 'https://example.com/products',
	ogTitle: 'Products',
	ogDescription: 'Browse our latest products.',
	ogImage: 'https://example.com/social.jpg',
	twitterCard: 'summary_large_image',
}
```

## Status Codes

```ts
const context = useSsrRequestContext()

context.response.statusCode = 404
```

## Redirects

```ts
const context = useSsrRequestContext()

context.response.redirect = {
	location: '/new-page',
	statusCode: 307,
}
```

## Domain Routing

Domain configuration lives on each application. The library owns normalization
(ports, trailing dots, IPv4/IPv6 aliases), proxy header handling, environment
selection (`development` vs `production`), host specificity matching, custom
domains, context serialization, and hydration.

```ts
import { defineSsrConfig, useSsrDomain } from 'vue-ssr-lite'

export default defineSsrConfig({
	name: 'my-platform',
	runtime: process.env.APP_RUNTIME,
	server: { trustProxy: true },
	applications: {
		admin: {
			render: 'spa',
			application: {
				module: './src/admin/AdminBootstrap.ts',
				exportName: 'createAdminApplication',
			},
			template: 'index.html',
			domain: {
				development: 'localhost',
				production: process.env.VITE_ROOT_DOMAIN!,
				mode: 'root-and-subdomains',
				localAliases: true,
				params: {
					workspace: { source: 'last-subdomain-label' },
				},
			},
			publicConfig: {
				api: { endpoint: process.env.VITE_API_ENDPOINT!, timeout: 8_000 },
			},
		},
		website: {
			render: 'ssr',
			application: {
				module: './src/website/SsrApplication.ts',
				exportName: 'websiteApplication',
			},
			template: 'site.html',
			domain: {
				development: 'shop.localhost',
				production: process.env.VITE_SHOP_BASE_DOMAIN!,
				mode: 'root-and-subdomains',
				customDomains: true,
				params: {
					storeDomain: { source: 'subdomain-or-hostname' },
				},
			},
			publicConfig: {
				api: { endpoint: process.env.VITE_API_ENDPOINT!, timeout: 8_000 },
			},
		},
	},
})
```

Consume the resolved context anywhere (SSR, SPA, endpoints, hydration):

```ts
const domain = useSsrDomain()

domain.entry
domain.hostname
domain.baseDomain
domain.subdomain
domain.isCustomDomain
domain.params.workspace
domain.params.storeDomain
domain.createUrl({ subdomain: 'department.acme', path: '/projects', query: { page: 2 } })
```

### Precedence

| Priority | Pattern | Example winner |
| --- | --- | --- |
| 1 | Exact hostname | `shop.localhost` over `*.localhost` |
| 2 | Longer wildcard suffix | `*.shop.localhost` over `*.localhost` |
| 3 | Shorter wildcard suffix | `*.localhost` over `*` |
| 4 | Catch-all `*` | custom domains with no specific rule |
| 5 | `defaultApplicationId` | only when no pattern matches |

Overlapping roots such as `*.localhost` and `*.shop.localhost` are supported
because the longer suffix wins. Duplicate exact/wildcard ownership and multiple
catch-all (`*`) applications are rejected at startup.

Do not include protocols, paths, query strings, or ports in domain values.

`localAliases: true` adds bare loopback hosts (`localhost`, `127.0.0.1`, …) only
when the app’s development base is itself a loopback hostname. Subdomain bases
such as `shop.localhost` already expand to `*.shop.localhost` and do not claim
bare `localhost`, so multiple apps can enable `localAliases` safely.

Set `server.trustProxy` to `true` only when the Node process sits behind a trusted reverse proxy. Then `X-Forwarded-Host` and `X-Forwarded-Proto` are used for host matching and absolute URLs. Leave it `false` for direct local traffic.

## Runtime Roles

Roles let one codebase and one Docker image run as different process modes.

- Set top-level `runtime` to the active mode for this process.
- Set `roles` on each application to list which modes may serve it.
- Omit `roles` (or omit `runtime`) to keep an application available in every mode.

Role names are application-defined strings. Common patterns:

| Mode | Typical use |
| --- | --- |
| `unified` | Local development or a single process that serves every application |
| A private role | SPA / admin / back-office only |
| A public role | SSR website / marketing / storefront only |

Example:

```ts
export default defineSsrConfig({
	name: 'my-platform',
	runtime: process.env.APP_RUNTIME, // required in production
	applications: {
		admin: {
			render: 'spa',
			application: {
				module: './src/admin/AdminBootstrap.ts',
				exportName: 'createAdminApplication',
			},
			template: 'index.html',
			roles: ['unified', 'admin'],
			domain: {
				development: 'localhost',
				production: process.env.VITE_ROOT_DOMAIN!,
				mode: 'root-and-subdomains',
				localAliases: true,
			},
			publicConfig: {
				api: { endpoint: process.env.VITE_API_ENDPOINT!, timeout: 8_000 },
			},
		},
		website: {
			render: 'ssr',
			application: {
				module: './src/website/SsrApplication.ts',
				exportName: 'websiteApplication',
			},
			template: 'site.html',
			roles: ['unified', 'website'],
			domain: {
				development: 'shop.localhost',
				production: process.env.VITE_SHOP_BASE_DOMAIN!,
				mode: 'root-and-subdomains',
				customDomains: true,
			},
			publicConfig: {
				api: { endpoint: process.env.VITE_API_ENDPOINT!, timeout: 8_000 },
			},
		},
	},
})
```

With that setup:

- `APP_RUNTIME=unified` serves both applications (host routing still applies).
- `APP_RUNTIME=admin` serves only the SPA application.
- `APP_RUNTIME=website` serves only the SSR application.

If a host matches an application that the current role does not allow, the server responds with `421`.

Development may omit `runtime` (the compiler defaults the process role to
`unified`). Production compilation rejects a missing `runtime` or
`domain.production`. It does **not** validate `publicConfig` shape — pass
whatever your plugins need and validate API URLs in the consumer.

For async loading, export `async () => defineSsrConfig({ ... })`.

## Custom Endpoints

```ts
endpoints: [
	{
		id: 'robots',

		match(request) {
			return request.pathname === '/robots.txt'
		},

		handle() {
			return {
				statusCode: 200,
				body: 'User-agent: *\nAllow: /',
				headers: {
					'content-type': 'text/plain; charset=utf-8',
				},
			}
		},
	},
]
```

Custom endpoints can be used for:

- `robots.txt`
- `sitemap.xml`
- Verification files
- Public JSON endpoints

## Health Checks

The server includes:

```text
/healthz
/readyz
```

Add readiness checks:

```ts
readiness: [
	{
		id: 'api',

		async run() {
			const response = await fetch('https://api.example.com/health')

			if (!response.ok) {
				throw new Error('API is unavailable.')
			}
		},
	},
]
```

## Response Caching

```ts
import { createSsrMemoryResponseCache } from 'vue-ssr-lite/server'

const responseCache = createSsrMemoryResponseCache({
	maxEntries: 500,
})
```

Add it on the application object:

```ts
website: {
  render: 'ssr',
  application: {
    module: './src/website/SsrApplication.ts',
    exportName: 'websiteApplication',
  },
  template: 'site.html',
  domain: {
    development: 'localhost',
    production: process.env.VITE_ROOT_DOMAIN!,
    customDomains: true,
  },
  responseCache: {
    store: responseCache,
    ttlMs: 60_000,
  },
  publicConfig: {
    api: { endpoint: process.env.VITE_API_ENDPOINT!, timeout: 8_000 },
  },
}
```

## Cookie Filtering

SSR requests can forward a filtered `Cookie` header to upstream APIs. Configure
cookies per application:

```ts
cookies: {
  allow: ['session'],
  deny: ['admin_token', 'refresh_token'],
}
```

- Both empty → forward nothing (secure default when SSR needs no cookies).
- `allow` empty and `deny` non-empty → forward all cookies except `deny`.
- `allow` non-empty → forward `allow ∩ ¬deny`.

## Server Configuration

```ts
server: {
  host: '0.0.0.0',
  port: 4173,
  trustProxy: false,
  requestTimeoutMs: 15_000,
  shutdownTimeoutMs: 10_000,
  healthPath: '/healthz',
  readinessPath: '/readyz',
  logger: {
    info: (event, details) => console.info(event, details ?? ''),
    warn: (event, details) => console.warn(event, details ?? ''),
    error: (event, details) => console.error(event, details ?? ''),
  },
}
```

The active process role comes from top-level `runtime`, not `server.role`.
`/healthz` and `/readyz` include that role in their JSON responses.

## Server-side data resolution

`renderToString` awaits each component's native `onServerPrefetch`, which covers
data consumed reactively inside the component that declared it. For work started
OUTSIDE that lifecycle — a store action, an i18n loader, a lazy query — the
package exposes a generic, API-client-neutral **resolution contract**.

An installed plugin obtains it by injecting `SSR_REQUEST_RESOLUTION`
(`Symbol.for('vue-ssr:request-resolution')`, resolvable without importing this
package). It registers in-flight work with `track(promise)` and may call
`requestAdditionalPass()`. After each render pass the renderer awaits registered
work and re-renders when a plugin asked for another pass, up to
`server.maxResolutionPasses` (default 4) and bounded by
`server.resolutionDeadlineMs` and the request abort signal.

A fully resolvable page completes in **one pass** — extra passes occur only when
a plugin left work pending or requested one. `vue-ssr-lite` never inspects the
work; it only awaits it.

### Deferred parent → child dependencies

A common pattern is: a parent query resolves, its result determines which child
components mount, and each child runs its own async work. When a child's data is
consumed DIRECTLY inside that child, a single pass suffices — Vue awaits the
child's `onServerPrefetch` before rendering it.

It does NOT suffice when the child's data is consumed INDIRECTLY — the child
writes into a shared store that a **sibling** component reads — because Vue does
not block a sibling's render on an earlier sibling's `onServerPrefetch`. The
sibling renders before the store is populated.

**Applications write no orchestration for this.** Reconcile resolved data into
the store with `ssrWatch` exactly as you already would:

```ts
const { result } = useMyQuery(vars, { ssr: true })
ssrWatch(() => result.value, (data) => {
  if (data) store.set(key, data)
}, { immediate: true })
```

`ssrWatch` automatically requests one more render pass when it fires from the
awaited prefetch (after a sibling already rendered). On the resumed pass the
data is warm in the API client's request cache — `vue-apollo-client` settles it
synchronously at setup — so the same `ssrWatch` runs on its immediate tick, the
sibling sees the store, and no further pass is requested. Bounded, and each
operation runs exactly once. Nothing app-specific, and nothing to repeat per
component or per project.

## SSR-safe reactivity

During SSR, Vue does not flush the scheduler, so `watch(src, cb)` and
`watchEffect` run at most once and are then discarded — the most common cause of
"the shell renders but the content is missing" bugs. Server-safe APIs:

| API | Server behaviour |
| --- | --- |
| `computed` | ✅ Lazily evaluated during render |
| `ssrWatch(src, cb)` / `ssrWatchEffect(fn)` | ✅ Sync flush, active during render |
| `watch(src, cb)` / `watchEffect(fn)` | ⚠️ Runs once (or never), then discarded |
| `onServerPrefetch(async fn)` | ✅ Awaited before the component renders |
| `onMounted` / `onUpdated` | ❌ Browser only |

Use a `computed` to derive a value for the template; reach for `ssrWatch` /
`ssrWatchEffect` (exported from `vue-ssr-lite` and `vue-ssr-lite/client`) when
resolved data must drive an imperative side effect during the server render.

## Runtime configuration helpers

`vue-ssr-lite/server` provides declarative helpers so a runtime definition is
configuration, not boilerplate: `ssrEnvBoolean`, `ssrEnvNumber`, `ssrEnvList`,
`requireSsrEnv`, `requireSsrHostname`, `requireSsrEnum`, `createSsrConsoleLogger`
and `createSsrSeoEndpoints` (`robots.txt` / `sitemap.xml` — `served`, `proxy` or
`disallow` by option). Host helpers such as `normalizeSsrHost` remain exported;
reuse them rather than re-implementing.

## Development diagnostics

When diagnostics are enabled (`server.diagnostics`, default on outside
production) the renderer reports, with actionable messages: a loading
placeholder or `aria-busy="true"` still present after resolution, a route that
matched no component, and a body that resolved to nothing. These are dev-only
warnings; production render paths are untouched.

## Summary

1. Add `ssr.config.ts` with `defineSsrConfig({ name, runtime, applications })`.
2. For each app: `defineSsrApplication()` module, HTML shell (no bootstrap script),
   `render: 'spa' | 'ssr'`, and `application: { module, exportName }`.
3. Wire Vite with `vue()` + `vueSsrLite()` (client assets land in `dist/client`).
4. Run `vue-ssr-lite dev|build|start`.
5. In production set `APP_RUNTIME` / `runtime` and every `domain.production`.

Optional: restrict apps with `roles`, filter cookies, add endpoints, or pass
`server.onMetrics` / `server.renderError` through `ssr.config`.

SPA and SSR apps share one project, one build, and one production server.

## License

MIT
