import { defineServerMiddleware } from 'vue-ssr-lite'

export interface AuthenticatedUser {
  id: string
  name: string
  role: 'admin' | 'member'
}

const authenticate = async (
  request: Request,
): Promise<AuthenticatedUser | null> => {
  const token = request.headers
    .get('authorization')
    ?.replace(/^Bearer\s+/i, '')
    .trim()

  if (!token) {
    return null
  }

  return {
    id: 'usr_1',
    name: 'Ada',
    role:
      token === 'admin-token'
        ? 'admin'
        : 'member',
  }
}

export const authMiddleware =
  defineServerMiddleware<{
    user: AuthenticatedUser
  }>(
    async (
      request,
      context,
      next,
    ) => {
      const user = await authenticate(
        request,
      )

      if (!user) {
        return Response.json(
          {
            error: 'Unauthorized.',
          },
          {
            status: 401,
          },
        )
      }

      context.user = user

      return next()
    },
  )
