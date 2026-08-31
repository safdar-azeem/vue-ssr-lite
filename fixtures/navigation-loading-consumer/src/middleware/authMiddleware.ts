import { defineMiddleware } from 'vue-ssr-lite'

let authRuns = 0

const wait = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }

    const onAbort = () => {
      globalThis.clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })

export const authMiddleware = defineMiddleware(async (context) => {
  authRuns += 1
  await wait(40, context.signal)
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
