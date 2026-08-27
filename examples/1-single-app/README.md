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
