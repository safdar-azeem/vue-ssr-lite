import { defineServerMiddleware } from 'vue-ssr-lite'
import { db } from '../db'
import type { Organization } from '../../shared/api'
import type { AuthenticatedUser } from './auth'

export const organizationMiddleware = defineServerMiddleware<
  { organization: Organization },
  {
    user: AuthenticatedUser
    params: { organizationId: string }
  }
>(async (_request, context, next) => {
  const organization = await db.organizations.find(context.params.organizationId)

  if (!organization) {
    return Response.json({ error: 'Organization not found.' }, { status: 404 })
  }

  context.organization = organization
  return next()
})
