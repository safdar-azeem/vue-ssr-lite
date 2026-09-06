import { defineServerMiddleware } from 'vue-ssr-lite'
import type {
  AuthenticatedUser,
} from './auth'

export const adminMiddleware =
  defineServerMiddleware<
    {
      isAdmin: true
    },
    {
      user: AuthenticatedUser
    }
  >(
    async (
      _request,
      context,
      next,
    ) => {
      if (
        context.user.role !== 'admin'
      ) {
        return Response.json(
          {
            error: 'Forbidden.',
          },
          {
            status: 403,
          },
        )
      }

      context.isAdmin = true

      return next()
    },
  )
