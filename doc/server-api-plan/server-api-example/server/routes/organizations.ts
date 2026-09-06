import { defineServerRoutes } from 'vue-ssr-lite'
import { organizationMiddleware } from '../middleware/organization'

export const organizationRoutes =
  defineServerRoutes({
    prefix:
      '/organizations/:organizationId',

    middleware: [
      organizationMiddleware,
    ],

    routes: {
      '/products/:productId': {
        GET(
          _request,
          context,
        ) {
          return Response.json({
            organization:
              context.organization,
            organizationId:
              context.params
                .organizationId,
            productId:
              context.params.productId,
          })
        },
      },
    },
  })
