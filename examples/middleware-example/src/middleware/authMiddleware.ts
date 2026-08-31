import { defineMiddleware } from 'vue-ssr-lite'

export const authMiddleware = defineMiddleware(async (context) => {
  const session = context.cookies.get('single_session')

  if (!session) {
    return {
      path: '/login',
      query: {
        redirect: context.to.fullPath,
      },
    }
  }

  // Middleware may do async work here before returning route props.
  // These props belong to the route record that declared this middleware.
  // For /dashboard/nested they are still injected into DashboardPage.vue,
  // not automatically into DashboardNestedPage.vue.
  return {
    props: {
      userName: 'john',
      role: 'admin',
    },
  }
})
