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
- Apollo, GraphQL, REST, Pinia, and i18n support
- SEO metadata and status codes
- Custom server endpoints
- Health and readiness checks
- Request timeouts
- Optional response caching
- Cookie allowlists and denylists
- Proxy-aware host and protocol resolution
- Graceful shutdown
- TypeScript support

## Package Entry Points

| Import | Purpose |
| --- | --- |
| `vue-ssr-lite` | `defineSsrApplication`, `defineSsrRuntime`, request context, hydration helpers |
| `vue-ssr-lite/client` | Browser hydration only |
| `vue-ssr-lite/server` | Managed Node server, host matching, cookies, response cache |
| `vue-ssr-lite/vite` | Vite plugin that wires HTML templates and virtual client entries |

CLI binary:

```bash
vue-ssr-lite <dev|build|start> [--root .] [--runtime src/SsrRuntime.ts] [--server-output dist/server/SsrRuntime.js] [--hmr-port 31001]
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

## Choose Your Application Type

`vue-ssr-lite` supports two application types.

### SPA

Use `kind: 'spa'` for a Vue application that runs in the browser.

Examples:

- Admin dashboard
- Internal application
- Editor
- Authenticated application
- Client-side portal

A single application definition is mountable in three modes — server render,
browser hydration of a server render, and pure client-side SPA. Define the app
once with `defineSsrApplication()` and mount it in the SPA entry with
`mountSpaApplication()`, so the SPA and SSR paths of the same application share
one plugin set, router and public-config delivery and cannot drift:

```ts
// src/main.ts — thin SPA entry over the shared definition
import { mountSpaApplication } from 'vue-ssr-lite/client'
import { app } from './app' // defineSsrApplication({ ... })

void mountSpaApplication(app)
```

A plain Vite `main.ts` (`createApp(App).use(router).mount('#app')`) still works
for an application that never needs SSR, but prefer the unified definition when
the same app also has an SSR entry.

### SSR

Use `kind: 'ssr'` for a Vue application that should render on the server and hydrate in the browser.

Examples:

- Public website
- Storefront
- Blog
- Marketing website
- Documentation website
- SEO-focused application

An SSR application is defined with `defineSsrApplication()`.

## Quick Start: SPA and SSR Together

The following example creates:

- A dashboard SPA on `app.example.com`
- A server-rendered website on all other hosts

## 1. Create the SPA Application

Define the application once and mount it through the package. Router creation,
plugin installation, public-config delivery and mounting are owned by
`vue-ssr-lite`, identically to the SSR and hydration paths:

```ts
// src/spa/app.ts
import { defineSsrApplication } from 'vue-ssr-lite'
import App from './App.vue'
import routes from './routes'

export const app = defineSsrApplication({
  id: 'dashboard',
  rootComponent: App,
  routes,
  plugins: [/* your Vue plugins */],
})
```

```ts
// src/spa/main.ts — thin entry
import { mountSpaApplication } from 'vue-ssr-lite/client'
import { app } from './app'

void mountSpaApplication(app)
```

Create the SPA root component:

```vue
<!-- src/spa/App.vue -->
<script setup lang="ts">
import { RouterView } from 'vue-router'
</script>

<template>
	<RouterView />
</template>
```

Create the SPA HTML entry:

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

		<script
			type="module"
			src="/src/spa/main.ts"></script>
	</body>
</html>
```

The same definition backs the SSR entry, so the SPA and SSR paths cannot drift.

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

## 3. Create the Runtime

The runtime tells the package which application should handle each host.

```ts
// src/SsrRuntime.ts
import { defineSsrRuntime } from 'vue-ssr-lite'

import { websiteApplication } from './website/SsrApplication'

export default defineSsrRuntime({
	name: 'my-platform',

	entries: [
		{
			id: 'dashboard',
			kind: 'spa',
			template: 'index.html',
			hosts: ['app.example.com', 'localhost'],
		},
		{
			id: 'website',
			kind: 'ssr',
			template: 'site.html',
			hosts: ['*'],
			application: websiteApplication,
		},
	],

	defaultEntryId: 'website',

	server: {
		host: '0.0.0.0',
		port: Number(process.env.PORT || 4173),
		role: process.env.APP_RUNTIME || 'unified',

		publicConfig: {
			apiUrl: process.env.PUBLIC_API_URL || 'http://localhost:4000',
		},
	},
})
```

The specific SPA hostname is checked first. The `*` SSR entry handles all remaining hosts.
`defaultEntryId` is used when no host pattern matches.

When the server starts, the console prints a ready message with a clickable local URL and the active role:

```text
✓  Server Ready

  ➜ Local:  http://localhost:4173/
  ➜ Role:   unified
```

## 4. Configure Vite

Register the SSR application and the normal SPA HTML entry:

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

import { vueSsrLite } from 'vue-ssr-lite/vite'

export default defineConfig({
	plugins: [
		vue(),

		vueSsrLite({
			applications: [
				{
					id: 'website',
					definition: 'src/website/SsrApplication.ts',
					exportName: 'websiteApplication',
					template: 'site.html',
				},
			],

			spaEntries: {
				dashboard: 'index.html',
			},
		}),
	],
})
```

### `applications`

Contains applications that use server-side rendering and browser hydration.

### `spaEntries`

Contains normal Vite SPA HTML entries.

Do not add SPA applications to the `applications` array.

## 5. Add Commands

```json
{
	"scripts": {
		"dev": "vue-ssr-lite dev --runtime src/SsrRuntime.ts",
		"build": "vue-ssr-lite build --runtime src/SsrRuntime.ts",
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

For a project that only needs SSR:

```ts
export default defineSsrRuntime({
	name: 'my-website',

	entries: [
		{
			id: 'website',
			kind: 'ssr',
			template: 'site.html',
			hosts: ['*'],
			application: websiteApplication,
		},
	],

	server: {
		publicConfig: {},
	},
})
```

Vite configuration:

```ts
vueSsrLite({
	applications: [
		{
			id: 'website',
			definition: 'src/website/SsrApplication.ts',
			exportName: 'websiteApplication',
			template: 'site.html',
		},
	],
})
```

## SPA-Only Application

A runtime can also serve a normal SPA without an SSR application:

```ts
export default defineSsrRuntime({
	name: 'my-dashboard',

	entries: [
		{
			id: 'dashboard',
			kind: 'spa',
			template: 'index.html',
			hosts: ['*'],
		},
	],

	server: {
		publicConfig: {},
	},
})
```

Vite configuration still requires at least one SSR application in the current `vueSsrLite()` API. For a completely SPA-only project, use normal Vite without the `vueSsrLite()` plugin.

## Using the Same Vue Plugins

You may use the same plugin configuration in your SPA and SSR applications.

For example:

```ts
// src/config/apollo.ts
import { defineApollo } from 'vue-apollo-client'

export default defineApollo(({ publicConfig }) => ({
	endPoints: {
		default:
			publicConfig?.graphqlEndpoint ||
			import.meta.env.VITE_GRAPHQL_ENDPOINT,
	},
}))
```

Use it in the SPA:

```ts
// src/spa/main.ts
import { createApp } from 'vue'

import apollo from '../config/apollo'
import App from './App.vue'
import router from './router'

const app = createApp(App)

app.use(apollo)
app.use(router)
app.mount('#app')
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

Pass public values from the runtime:

```ts
server: {
  publicConfig: {
    apiUrl:
      'https://api.example.com',
    graphqlEndpoint:
      'https://api.example.com/graphql',
  },
}
```

Access them in an SSR component:

```ts
import { useSsrRequestContext } from 'vue-ssr-lite'

const context = useSsrRequestContext()

const apiUrl = context.publicConfig.apiUrl
```

Only include values that are safe to expose to the browser.

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

Exact hostname:

```ts
hosts: ['example.com']
```

Subdomains:

```ts
hosts: ['*.example.com']
```

Exact hostname and subdomains:

```ts
hosts: ['example.com', '*.example.com']
```

Catch-all:

```ts
hosts: ['*']
```

Do not include protocols or paths in host values.

Set `server.trustProxy` to `true` only when the Node process sits behind a trusted reverse proxy. Then `X-Forwarded-Host` and `X-Forwarded-Proto` are used for host matching and absolute URLs. Leave it `false` for direct local traffic.

## Runtime Roles

Roles let one codebase and one Docker image run as different process modes.

- Set `server.role` to the active mode for this process.
- Set `roles` on each entry to list which modes may serve that entry.
- Omit `roles` (or omit `server.role`) to keep an entry available in every mode.

Role names are application-defined strings. Common patterns:

| Mode | Typical use |
| --- | --- |
| `unified` | Local development or a single process that serves every entry |
| A private role | SPA / admin / back-office only |
| A public role | SSR website / marketing / storefront only |

Example:

```ts
export default defineSsrRuntime({
	name: 'my-platform',

	entries: [
		{
			id: 'admin',
			kind: 'spa',
			template: 'index.html',
			hosts: ['app.example.com', 'localhost'],
			roles: ['unified', 'admin'],
		},
		{
			id: 'website',
			kind: 'ssr',
			template: 'site.html',
			hosts: ['*'],
			roles: ['unified', 'website'],
			application: websiteApplication,
		},
	],

	server: {
		role: process.env.APP_RUNTIME || 'unified',
		publicConfig: {},
	},
})
```

With that setup:

- `APP_RUNTIME=unified` serves both entries (host routing still applies).
- `APP_RUNTIME=admin` serves only the SPA entry.
- `APP_RUNTIME=website` serves only the SSR entry.

If a host matches an entry that the current role does not allow, the server responds with `421`.

You can also load role-specific code only when needed:

```ts
export default async () => {
	const role = process.env.APP_RUNTIME || 'unified'
	const websiteApplication =
		role === 'admin'
			? undefined
			: (await import('./website/SsrApplication')).websiteApplication

	return defineSsrRuntime({
		name: 'my-platform',
		entries: [
			{
				id: 'admin',
				kind: 'spa',
				template: 'index.html',
				hosts: ['app.example.com'],
				roles: ['unified', 'admin'],
			},
			{
				id: 'website',
				kind: 'ssr',
				template: 'site.html',
				hosts: ['*'],
				roles: ['unified', 'website'],
				application: websiteApplication,
			},
		],
		server: {
			role,
			publicConfig: {},
		},
	})
}
```

`defineSsrRuntime` accepts either a plain object or an async factory function.

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

Add it to an SSR entry:

```ts
{
  id: 'website',
  kind: 'ssr',
  template: 'site.html',
  hosts: ['*'],
  application: websiteApplication,

  responseCache: {
    store: responseCache,
    ttlMs: 60_000,
  },
}
```

## Cookie Filtering

SSR requests can forward a filtered `Cookie` header to upstream APIs.

```ts
server: {
  cookieAllowlist: ['session'],
  cookieDenylist: ['admin_token', 'refresh_token'],
  publicConfig: {},
}
```

- If `cookieAllowlist` is non-empty, only listed cookies are forwarded.
- `cookieDenylist` always removes matching cookies.
- Leave both empty when the browser talks to the API directly and SSR needs no cookies.

## Server Configuration

```ts
server: {
  host: '0.0.0.0',
  port: 4173,
  role: 'unified',

  publicConfig: {},

  requestTimeoutMs: 15_000,
  shutdownTimeoutMs: 10_000,

  healthPath: '/healthz',
  readinessPath: '/readyz',

  trustProxy: false,

  cookieAllowlist: [],
  cookieDenylist: [],

  logger: {
    info: (event, details) => console.info(event, details ?? ''),
    warn: (event, details) => console.warn(event, details ?? ''),
    error: (event, details) => console.error(event, details ?? ''),
  },
}
```

`/healthz` and `/readyz` include the active `role` in their JSON responses.

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

For a SPA:

1. Define the app once with `defineSsrApplication()`.
2. Mount it in a thin `main.ts` with `mountSpaApplication()`.
3. Register the HTML file in `spaEntries`.
4. Add a runtime entry with `kind: 'spa'`.

For SSR:

1. Create the Vue root component and routes.
2. Define it with `defineSsrApplication()`.
3. Create an SSR HTML template.
4. Register it in `applications`.
5. Add a runtime entry with `kind: 'ssr'`.

Optional for multi-mode deployments:

1. Choose role names for your project.
2. Set `server.role` from an environment variable.
3. Restrict each entry with `roles`.

Both application types can run from the same project, build process, and production server.

## License

MIT
