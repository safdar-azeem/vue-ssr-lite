import { defineServerMiddleware } from 'vue-ssr-lite'
import type { ApiUser } from '../../shared/api'

export type AuthenticatedUser = ApiUser

const usersByToken: Record<string, AuthenticatedUser> = {
  'member-token': {
    id: 'usr_member',
    name: 'Ada Member',
    role: 'member',
  },
  'admin-token': {
    id: 'usr_admin',
    name: 'Grace Admin',
    role: 'admin',
  },
}

const authenticate = async (request: Request): Promise<AuthenticatedUser | null> => {
  const token = request.headers
    .get('authorization')
    ?.replace(/^Bearer\s+/i, '')
    .trim()

  if (!token) return null
  return usersByToken[token] ?? null
}

export const authMiddleware = defineServerMiddleware<{
  user: AuthenticatedUser
}>(async (request, context, next) => {
  const user = await authenticate(request)

  if (!user) {
    return Response.json(
      {
        error: 'Unauthorized.',
        hint: 'Use Bearer member-token or Bearer admin-token in this example.',
      },
      { status: 401 },
    )
  }

  context.user = user
  return next()
})
