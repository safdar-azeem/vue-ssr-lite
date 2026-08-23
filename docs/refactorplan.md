## Target Architecture

```text
                         HOSTED VUE APPLICATION
                    (Builto Landing / future apps)
                                │
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
                       │ vue-ssr-lite   │
                       │                │
                       │ Application    │
                       │ Router         │
                       │ SSR            │
                       │ Hydration      │
                       │ SEO            │
                       │ Head           │
                       │ Canonical      │
                       │ Sitemap        │
                       │ robots.txt     │
                       │ 404 handling   │
                       │ Public origin  │
                       │ SSR context    │
                       │ Serialization  │
                       │ Server runtime │
                       └───────┬────────┘
                               │
                     optional integration
                               │
                               ▼
                         ┌───────────┐
                         │  vlite3   │
                         │           │
                         │ UI        │
                         │ Seo UI/API│
                         │ SPA SEO   │
                         └───────────┘
```

# 1. Hosted Application Structure

The normal hosted application should look like:

```text
builto-landing/
│
├── index.html
├── vite.config.ts
│
└── src/
    ├── main.ts
    ├── App.vue
    │
    ├── pages/
    │   ├── Home.vue
    │   ├── About.vue
    │   ├── Contact.vue
    │   └── NotFound.vue
    │
    └── routes/
        └── index.ts
```

Normally there should be **no**:

```text
LandingSsrContext.ts
PublicSsrSeo.ts
PublicSiteOrigin.ts
LandingPublicRuntime.ts
LandingSeoEndpoints.ts
entry-client.ts
entry-server.ts
hydrate.ts
server.ts
```

And normally:

```text
ssr.config.ts
```

should also be unnecessary.

---

# 2. `main.ts`

Minimal:

```ts
import { defineApplication } from 'vue-ssr-lite'
import App from './App.vue'
import routes from './routes'

export default defineApplication({
	root: App,
	routes,
})
```

With other normal plugins:

```ts
export default defineApplication({
	root: App,
	routes,

	plugins: [apollo, createVLite()],
})
```

Nothing SSR-specific.

---

# 3. SEO API Moves Into `vue-ssr-lite`

`vue-ssr-lite` should expose:

```ts
import { useSeo } from 'vue-ssr-lite'
```

Then any page can simply do:

```vue
<script setup lang="ts">
import { useSeo } from 'vue-ssr-lite'

useSeo({
	title: 'About Builto',
	description: 'Learn more about Builto and its products.',
})
</script>
```

Homepage:

```ts
useSeo({
	title: 'Builto — One workspace for your work',
	description: 'Create websites, resumes, invoices, notes and more.',
})
```

Contact:

```ts
useSeo({
	title: 'Contact Builto',
	description: 'Get in touch with the Builto team.',
})
```

404:

```ts
useSeo({
	title: 'Page Not Found',
	index: false,
})
```

That is all the hosted developer should need.

---

# 4. Full `useSeo()` Capability

```ts
useSeo({
	title: 'About Builto',

	description:
		'Learn about Builto and the applications in the Builto ecosystem.',

	image: '/assets/social/about.png',

	canonical: '/about',

	index: true,
	follow: true,

	openGraph: {
		type: 'website',
		title: 'About Builto',
		description: '...',
		image: '/assets/social/about.png',
	},

	twitter: {
		card: 'summary_large_image',
	},

	structuredData: {
		'@type': 'WebPage',
		name: 'About Builto',
	},
})
```

But all fields except `title`/`description` should be optional.

---

# 5. Automatic Defaults

If developer writes only:

```ts
useSeo({
	title: 'About Builto',
	description: 'About our product.',
})
```

`vue-ssr-lite` automatically generates:

```text
<title>

<meta name="description">

<link rel="canonical">

<meta property="og:title">

<meta property="og:description">

<meta property="og:url">

<meta property="og:type">

<meta name="twitter:card">

<meta name="robots">
```

No manual adapters.

No manual head resolver.

No SSR context code.

---

# 6. Origin Resolution

Hosted applications should NEVER need:

```ts
publicSiteOrigin()
```

or:

```ts
LandingPublicRuntime
```

`vue-ssr-lite` resolves the public origin internally.

### Server

```text
forwarded proto + forwarded host
        ↓
request protocol + Host
        ↓
resolved public origin
```

Example:

```text
https://builto.com
```

### Browser

```ts
window.location.origin
```

So:

```ts
useSeo({
	canonical: '/about',
})
```

becomes automatically:

```html
<link
	rel="canonical"
	href="https://builto.com/about" />
```

Developer never constructs the full URL.

---

# 7. Optional Canonical Override

Only unusual deployments should configure this:

```ts
defineApplication({
	root: App,
	routes,

	seo: {
		origin: 'https://builto.com',
	},
})
```

But this should be optional.

Default:

```text
current trusted request origin
```

---

# 8. Global SEO Defaults

Application can optionally define site-wide defaults once:

```ts
export default defineApplication({
	root: App,
	routes,

	seo: {
		siteName: 'Builto',

		defaultTitle: 'Builto',

		defaultDescription:
			'Websites, resumes, invoices, notes, planning and more.',

		defaultImage: '/assets/brand/social-card.png',

		titleTemplate: '%s | Builto',
	},
})
```

Then pages only write:

```ts
useSeo({
	title: 'About',
	description: 'Learn more about Builto.',
})
```

Result:

```text
About | Builto
```

---

# 9. Sitemap Should Be Automatic

Routes:

```ts
const routes = [
	{
		path: '/',
		component: Home,
	},

	{
		path: '/about',
		component: About,
	},

	{
		path: '/contact',
		component: Contact,
	},

	{
		path: '/user/dashboard',
		component: Dashboard,
		meta: {
			requiresAuth: true,
		},
	},
]
```

`vue-ssr-lite` automatically generates:

```xml
/sitemap.xml
```

containing:

```text
/
/about
/contact
```

and automatically excludes:

```text
/user/dashboard
```

because:

```ts
meta.requiresAuth === true
```

---

# 10. Explicit Sitemap Control When Needed

Developer can optionally say:

```ts
{
  path: '/internal',
  component: InternalPage,

  meta: {
    seo: {
      index: false,
    },
  },
}
```

Then `vue-ssr-lite` automatically excludes it from:

```text
sitemap.xml
```

and outputs:

```html
<meta
	name="robots"
	content="noindex, nofollow" />
```

---

# 11. Dynamic Routes

Example:

```text
/blog/:slug
```

The library cannot automatically know all database slugs.

Support:

```ts
defineApplication({
	seo: {
		sitemap: {
			async dynamicRoutes() {
				return ['/blog/article-one', '/blog/article-two']
			},
		},
	},
})
```

Only dynamic content requires explicit input.

Static routes remain automatic.

---

# 12. `robots.txt` Automatic

Default generated automatically:

```text
User-agent: *
Allow: /

Sitemap: https://builto.com/sitemap.xml
```

Authenticated/private routes can automatically become:

```text
Disallow: /user/
```

No `LandingSeoEndpoints.ts`.

No XML generation inside hosted apps.

---

# 13. Structured Data

`vue-ssr-lite` should support generic JSON-LD:

```ts
useSeo({
	structuredData: {
		'@type': 'Organization',
		name: 'Builto',
		url: '/',
	},
})
```

Or multiple entries:

```ts
useSeo({
	structuredData: [
		{
			'@type': 'Organization',
			name: 'Builto',
		},

		{
			'@type': 'SoftwareApplication',
			name: 'Builto',
		},
	],
})
```

The library handles:

```text
serialization
escaping
<script type="application/ld+json">
SSR injection
hydration
deduplication
```

---

# 14. SSR SEO Lifecycle

Internally:

```text
Request
   │
   ▼
vue-ssr-lite creates request context
   │
   ▼
createSSRApp()
   │
   ▼
router resolves route
   │
   ▼
Vue renders page
   │
   ▼
page calls useSeo()
   │
   ▼
request-scoped SEO store updated
   │
   ▼
renderToString()
   │
   ▼
vue-ssr-lite reads final SEO state
   │
   ▼
generates <head>
   │
   ▼
generates canonical
   │
   ▼
generates JSON-LD
   │
   ▼
serializes hydration SEO state
   │
   ▼
HTML response
```

All internal.

---

# 15. Browser Lifecycle

After hydration:

```text
Vue Router navigation
       │
       ▼
new page setup()
       │
       ▼
useSeo(...)
       │
       ▼
vue-ssr-lite SEO store
       │
       ▼
DOM head synchronizer
       │
       ▼
document.title
meta
canonical
OG
JSON-LD
```

Same API.

Server and browser:

```ts
useSeo()
```

No distinction.

---

# 16. Keep SEO in `vlite3`

Do not remove:

```ts
useSeo
SeoProvider
SEO helpers
structured-data helpers
```

from `vlite3`.

Instead create a shared SEO core.

Architecture:

```text
                 @vue-ssr-lite/seo-core
                         │
              ┌──────────┴──────────┐
              │                     │
      vue-ssr-lite                vlite3
              │                     │
      SSR + universal SEO       UI / SPA usage
```

Or keep the core inside `vue-ssr-lite` and let vlite3 adapt/re-export it.

Preferred public APIs:

```ts
// SSR-first applications
import { useSeo } from 'vue-ssr-lite'
```

and still:

```ts
// vlite3 applications
import { useSeo } from 'vlite3'
```

Both should share compatible SEO types/state.

---

# 17. Request Context Becomes Internal

Hosted application should never need:

```ts
useSsrRequestContext()
```

for normal SEO.

Therefore remove from Builto:

```text
LandingSsrContext.ts
```

The SSR library internally owns:

```text
request
response
head
SEO state
public origin
hydration state
route
application ID
```

Only advanced library/plugin developers should use request context APIs.

---

# 18. Public Config Also Becomes Automatic

For common `VITE_*` client variables:

```text
VITE_API_URL
VITE_GRAPHQL_ENDPOINT
```

the hosted application should use normal Vite configuration.

SSR should not require:

```text
LandingPublicRuntime.ts
LandingPublicConfig
publicConfig bridge
```

unless a server-only value explicitly needs safe serialization.

Provide an advanced API only when necessary:

```ts
defineApplication({
	publicConfig() {
		return {
			apiUrl: process.env.PUBLIC_API_URL,
		}
	},
})
```

But normal apps should not need it.

---

# 19. 404 Handling

Route:

```ts
{
  path: '/:pathMatch(.*)*',
  component: NotFound,
  meta: {
    notFound: true,
  },
}
```

`vue-ssr-lite` automatically:

```text
HTTP 404
+
noindex
+
nofollow
+
no canonical
```

Page only needs:

```ts
useSeo({
	title: 'Page Not Found',
})
```

Potentially even that could be optional.

---

# 20. Private Routes

```ts
{
  path: '/user/dashboard',

  meta: {
    requiresAuth: true,
  },
}
```

Default SSR SEO behavior:

```text
noindex
nofollow
exclude sitemap
```

No separate:

```ts
createPrivateSeo()
```

needed unless custom title/description is desired.

---

# 21. Final Builto Landing

Desired files:

```text
src/
├── main.ts
├── App.vue
├── routes/
│   └── index.ts
│
└── pages/
    ├── Home.vue
    ├── About.vue
    ├── Contact.vue
    └── NotFound.vue

index.html
vite.config.ts
```

Optional:

```text
src/seo.ts
```

only if Builto wants reusable SEO content/constants.

---

# 22. Files We Should Eventually Remove

From the current landing application:

```text
DELETE
├── src/LandingSsrContext.ts
├── src/modules/Public/seo/PublicSsrSeo.ts
├── src/modules/Public/utils/PublicSiteOrigin.ts
├── src/config/LandingPublicRuntime.ts
└── src/server/LandingSeoEndpoints.ts
```

And preferably:

```text
DELETE ssr.config.ts
```

unless Builto has a genuinely unusual server-specific requirement.

---

# 23. Final Developer Experience

Install:

```bash
yarn add vue-ssr-lite
```

Vite:

```ts
export default defineConfig({
	plugins: [vue(), vueSsrLite()],
})
```

Application:

```ts
export default defineApplication({
	root: App,
	routes,

	seo: {
		siteName: 'Builto',
		defaultTitle: 'Builto',
		defaultDescription:
			'Everything you need to create and organize your work.',
	},
})
```

Page:

```ts
useSeo({
	title: 'About',
	description: 'Learn more about Builto.',
})
```

And automatically:

```text
SSR
hydration
<title>
description
canonical
Open Graph
Twitter cards
JSON-LD
robots
sitemap
404 SEO
private-route noindex
route changes
origin resolution
head serialization
head hydration
```

## Final architecture

```text
HOSTED APPLICATION
      │
      │
      ├── defineApplication()
      │
      ├── routes
      │
      └── useSeo()
              │
              ▼
        vue-ssr-lite
              │
      ┌───────┼────────┐
      │       │        │
     SSR     SEO     Router
      │       │        │
      │   canonical    │
      │   sitemap      │
      │   robots       │
      │   JSON-LD      │
      │   head         │
      │       │        │
      └───────┼────────┘
              │
              ▼
           Browser
```

**Hosted apps describe. `vue-ssr-lite` handles.**
