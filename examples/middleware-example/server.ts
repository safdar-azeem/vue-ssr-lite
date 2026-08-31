import { defineServer } from 'vue-ssr-lite'
import { loggerMiddleware } from './src/middleware/loggerMiddleware'

export default defineServer({
  render: 'ssr',

  server: {
    port: 4211,
  },

  // Global middleware runs for every route.
  middleware: [loggerMiddleware],
})
