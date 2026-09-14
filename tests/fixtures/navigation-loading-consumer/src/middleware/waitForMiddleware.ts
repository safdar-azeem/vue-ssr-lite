interface MiddlewareFixtureWindow {
  __VSSL_WAIT_FOR_MIDDLEWARE__?: () => Promise<void>
}

// The regression holds middleware until it has observed both loading UIs.
// A fixed 40 ms window alone can expire between browser-driver polls under
// parallel suite load. This hook belongs only to the fixture, not the runtime.
export const waitForMiddleware = (signal: AbortSignal, browser: boolean) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timer !== undefined) globalThis.clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const finish = () => {
      cleanup()
      resolve()
    }
    const fail = (reason: unknown) => {
      cleanup()
      reject(reason)
    }
    const onAbort = () => fail(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })

    const controlledWait =
      browser && typeof window !== 'undefined'
        ? (window as Window & MiddlewareFixtureWindow).__VSSL_WAIT_FOR_MIDDLEWARE__
        : undefined
    if (controlledWait) {
      void Promise.resolve().then(controlledWait).then(finish, fail)
    } else {
      timer = globalThis.setTimeout(finish, 40)
    }
  })
