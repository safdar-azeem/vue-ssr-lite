import { defineMiddleware } from 'vue-ssr-lite'
import { waitForMiddleware } from './waitForMiddleware'

let authRuns = 0

export const authMiddleware = defineMiddleware(async (context) => {
  authRuns += 1
  await waitForMiddleware(context.signal, !context.server)
  if (context.cookies.get('single_session') !== 'yes') {
    return {
      path: '/login',
      query: { redirect: context.to.fullPath },
    }
  }
  return {
    props: {
      userName: 'john',
      role: 'admin',
      authRuns,
    },
  }
})
