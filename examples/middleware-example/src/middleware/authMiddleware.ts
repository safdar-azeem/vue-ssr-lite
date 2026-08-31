import { defineMiddleware } from 'vue-ssr-lite'

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

export const authMiddleware = defineMiddleware(async (context) => {
  // Deliberately slow so RouteSuspense and LoadingIndicator are easy to see.
  // Real navigation checks should normally finish as quickly as possible.
  await sleep(2000, context.signal)
  console.log('run for 2 seconds')

  const session = context.cookies.get('single_session')

  if (!session) {
    return {
      path: '/login',
      query: {
        redirect: context.to.fullPath,
      },
    }
  }

  return {
    props: {
      userName: 'john',
      role: 'admin',
    },
  }
})
