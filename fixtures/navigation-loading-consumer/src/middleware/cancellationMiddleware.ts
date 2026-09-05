import { defineMiddleware } from 'vue-ssr-lite'
import { waitForMiddleware } from './waitForMiddleware'

export const cancellationMiddleware = defineMiddleware(async (context) => {
  await waitForMiddleware(context.signal, !context.server)
  return false
})
