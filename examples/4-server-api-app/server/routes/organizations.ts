import { defineServerRoutes } from 'vue-ssr-lite'
import { db } from '../db'
import { authMiddleware } from '../middleware/auth'
import { organizationMiddleware } from '../middleware/organization'

export const organizationRoutes = defineServerRoutes({
  prefix: '/api/organizations/:organizationId',

  // Prefix params are already available to group middleware.
  middleware: [
    authMiddleware,
    organizationMiddleware,
  ],

  routes: {
    '/products/:productId': {
      async GET(_request, context) {
        const product = await db.products.find(context.params.productId)

        if (!product) {
          return Response.json({ error: 'Product not found.' }, { status: 404 })
        }

        return Response.json({
          organization: context.organization,
          product,
          viewer: context.user,
        })
      },
    },
  },
})
