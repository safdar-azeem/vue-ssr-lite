import { defineServerRoutes } from 'vue-ssr-lite'

export const healthRoutes =
  defineServerRoutes({
    routes: {
      '/api/health': {
        GET(
          _request,
          context,
        ) {
          return Response.json({
            status: 'ok',
            requestId:
              context.requestId,
          })
        },
      },
    },
  })
