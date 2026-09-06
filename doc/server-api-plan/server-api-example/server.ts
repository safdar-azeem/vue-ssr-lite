import { defineServer } from 'vue-ssr-lite'
import { loggerMiddleware } from './server/middleware/logger'
import { serverRoutes } from './server/routes'

export default defineServer({
  render: 'ssr',

  server: {
    port: 4211,
    trustProxy: true,
  },

  serverMiddleware: [
    loggerMiddleware,
  ],

  serverRoutes,
})
