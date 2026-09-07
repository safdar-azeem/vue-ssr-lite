import { defineServerMiddleware } from 'vue-ssr-lite'

export const loggerMiddleware = defineServerMiddleware(async (request, context, next) => {
  const startedAt = performance.now()
  const response = await next()

  console.log('[http]', {
    requestId: context.requestId,
    method: request.method,
    path: new URL(request.url).pathname,
    status: response.status,
    durationMs: Math.round(performance.now() - startedAt),
  })

  return response
})
