import { defineServer } from 'vue-ssr-lite'
import { siteSeo } from './src/seo/site'
import { sitemap } from './src/seo/sitemap'
import { robots } from './src/seo/robots'
import { loggerMiddleware } from './src/middleware/loggerMiddleware'
import { productsEndpoint } from './server/products'
export default defineServer({
  render: 'ssr',

  server: {
    port: 4211,
    trustProxy: true,
  },

  seo: {
    site: siteSeo,
    sitemap,
    robots,
  },

  // Global middleware runs for every route.
  middleware: [loggerMiddleware],
  endpoints: [productsEndpoint],

  // No `app` config required.
  // Defaults:
  //   main -> /src/main.ts
  //   root -> /src/App.vue
})
