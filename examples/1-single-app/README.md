# Simple Single Application

`server.ts` is the only server configuration file. `/src/main.ts` and `/src/App.vue` are used automatically. No `defineApplication()` is required.

This example demonstrates:

- SSR
- Pinia installed per app/request in `main.ts`
- global `App.vue`
- routes from `src/routes.ts`
- global SEO, route SEO, and dynamic `useSeo()`
- sitemap and robots configured on `defineServer({ seo })`

```ts
import { defineServer } from 'vue-ssr-lite'

export default defineServer({
  render: 'ssr',
  server: { port: 4211 },
})
```

## SSR Data Fetching

The `/products` route fetches product data from the public [DummyJSON products API](https://dummyjson.com/products).

When `/products` is requested directly, the `fetch()` request runs from the
page's async setup while Vue is server-rendering. The response therefore
contains the product titles and details in the server-generated HTML before
hydration.

The same `ProductsPage.vue` component also works during normal Vue Router
navigation in the browser, where it runs as normal Vue application code. It
uses native `fetch()` directly; no local API server, proxy, database, or
vue-ssr-lite-specific data-fetching abstraction is required.

`App.vue` uses the enhanced `RouterView`, which coordinates navigation with
native Vue `<Suspense>` so async setup has the same browser-side fallback. The
route outlet does not fetch data itself.

DummyJSON is an external demonstration service, so its availability is outside
vue-ssr-lite's control. The page renders a small friendly error state when the
request fails or returns a non-2xx response.
