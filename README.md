# vue-ssr-lite

A lightweight Server-Side Rendering (SSR) runtime for **Vue 3**.

`vue-ssr-lite` adds SSR, hydration, SEO, sitemaps, robots.txt, public runtime configuration, and production server tooling without requiring a full framework.

## Features

- Vue 3 + Vite SSR
- Automatic browser hydration
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

## Supported versions

The pre-v1 line is supported with the following host-owned runtime/tooling:

| Dependency | Supported range |
| ---------- | --------------- |
| Node.js    | `>=22.12.0`     |
| Vue        | `^3.5.0`        |
| Vue Router | `^4.6.0`        |
| Vite       | `^7.0.0`        |

Vue, Vue Router, and Vite are peer dependencies supplied by the application.
Newer major versions are unverified and are not part of the supported contract.

---

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

```html
<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta
			name="viewport"
			content="width=device-width, initial-scale=1.0" />
		<title>My App</title>
	</head>

	<body>
		<div id="app"></div>
		<script
			type="module"
			src="/src/main.ts"></script>
	</body>
</html>
```

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

SEO can be defined in three places:

1. Application defaults with `defineApplication({ seo })`
2. Route metadata with `meta.seo`
3. Page/component SEO with `useSeo()`

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
		siteUrl: 'https://example.com',
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

useSeo({
	title: computed(() => props.product.name),
	description: computed(() => props.product.description),
	image: computed(() => props.product.image),
})
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
	},

	twitter: {
		card: 'summary_large_image',
	},
})
```

Values can be plain values, refs, computed refs, or getters.

## Structured Data

```ts
useSeo({
	structuredData: {
		'@context': 'https://schema.org',
		'@type': 'Product',
		name: 'Example Product',
	},
})
```

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
import { setResponseStatus, useSeo } from 'vue-ssr-lite'

const article = await fetchArticle()

if (!article) {
	setResponseStatus(404)
	useSeo({ title: 'Article Not Found' })
}
```

4xx and 5xx SSR responses are automatically marked `noindex` when built-in SEO is enabled.

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
	const articles = await loadPublishedArticles()

	return articles.map((article) => ({
		loc: `/blog/${article.slug}`,
		lastmod: article.updatedAt,
	}))
})
```

Supported entry shape:

```ts
{
  loc: '/blog/example',
  lastmod: new Date(),
}
```

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
			disallow: ['/admin/', '/private/'],
		},
	},
})
```

If `public/robots.txt` exists, that file is used instead.

---

# Public Runtime Configuration

Use `publicConfig` to pass browser-safe server configuration into Vue.

## Server

```ts
// ssr.config.ts
import { defineSsrConfig } from 'vue-ssr-lite/server'

export default defineSsrConfig({
	publicConfig: () => ({
		apiUrl: process.env.PUBLIC_API_URL,
		environment: process.env.NODE_ENV,
	}),
})
```

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

`publicConfig` is sent to the browser. Never place passwords, private keys, database credentials, or other secrets inside it.

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
	setResponseStatus,
	defineExtension,
} from 'vue-ssr-lite'
```

| API                 | Purpose                              |
| ------------------- | ------------------------------------ |
| `defineApplication` | Define the universal Vue application |
| `useSeo`            | Set reactive SEO/head data           |
| `usePublicConfig`   | Read browser-safe server config      |
| `useSiteOrigin`     | Read resolved public origin          |
| `setResponseStatus` | Set SSR HTTP status                  |
| `defineExtension`   | Create an advanced runtime extension |

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
			host: 'example.com',
		},

		admin: {
			app: './src/admin/main.ts',
			host: 'admin.example.com',
		},
	},
})
```

The object key is the application ID.

## SSR and SPA Together

```ts
export default defineSsrConfig({
	applications: {
		website: {
			app: './src/website/main.ts',
			host: 'example.com',
			render: 'ssr',
		},

		admin: {
			app: './src/admin/main.ts',
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

Requests with forwarded cookies bypass the shared response cache.

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
