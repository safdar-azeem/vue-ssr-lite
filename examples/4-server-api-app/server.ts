import { defineServer } from 'vue-ssr-lite'
import { loggerMiddleware } from './server/middleware/logger'
import { responseHeadersMiddleware } from './server/middleware/responseHeaders'
import { serverRoutes } from './server/routes'

export default defineServer({
  render: 'ssr',

  server: {
    port: 4211,
  },

  serverMiddleware: [
    loggerMiddleware,
    responseHeadersMiddleware,
  ],

  serverRoutes,
})
