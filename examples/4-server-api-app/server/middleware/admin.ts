import { defineServerMiddleware } from 'vue-ssr-lite'
import type { AuthenticatedUser } from './auth'

export const adminMiddleware = defineServerMiddleware<
  { isAdmin: true },
  { user: AuthenticatedUser }
>(async (_request, context, next) => {
  if (context.user.role !== 'admin') {
    return Response.json(
      {
        error: 'Forbidden.',
        hint: 'DELETE uses Bearer admin-token in this example.',
      },
      { status: 403 },
    )
  }

  context.isAdmin = true
  return next()
})
