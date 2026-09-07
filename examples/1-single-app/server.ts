import { defineServer } from 'vue-ssr-lite'
import { siteSeo } from './src/seo/site'
import { sitemap } from './src/seo/sitemap'
import { robots } from './src/seo/robots'
import { loggerMiddleware } from './src/middleware/loggerMiddleware'
import { productsRoutes } from './server/products'
import { loggerMiddleware as serverLoggerMiddleware } from './server/middleware/logger'

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

  // Vue navigation middleware runs for every page navigation.
  middleware: [loggerMiddleware],
  serverMiddleware: [serverLoggerMiddleware],
  serverRoutes: [productsRoutes],

  // No `app` config required.
  // Defaults:
  //   main -> /src/main.ts
  //   root -> /src/App.vue
})
