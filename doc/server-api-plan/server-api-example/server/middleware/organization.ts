import { defineServerMiddleware } from 'vue-ssr-lite'

export interface Organization {
  id: string
  name: string
}

export const organizationMiddleware =
  defineServerMiddleware<
    {
      organization: Organization
    },
    {
      params: {
        organizationId: string
      }
    }
  >(
    async (
      _request,
      context,
      next,
    ) => {
      context.organization = {
        id:
          context.params.organizationId,
        name: 'Example organization',
      }

      return next()
    },
  )
