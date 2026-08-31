import { defineMiddleware } from 'vue-ssr-lite'

export const loggerMiddleware = defineMiddleware(({ to, from, server }) => {
  console.log('[middleware]', {
    runtime: server ? 'server' : 'browser',
    from: from?.fullPath ?? null,
    to: to.fullPath,
  })
})
