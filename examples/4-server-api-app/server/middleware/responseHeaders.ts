import { defineServerMiddleware } from 'vue-ssr-lite'

export const responseHeadersMiddleware = defineServerMiddleware(async (_request, context, next) => {
  const response = await next()

  response.headers.set('x-example-app', 'server-api')
  response.headers.set('x-request-id', context.requestId)

  return response
})
