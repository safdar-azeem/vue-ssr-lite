// Core and the renderer may belong to separate Vite module graphs. Carry the
// accepted origin on this request only, without a public field or hydration flag.
const TRUSTED_LOCAL_ORIGIN = Symbol.for('vue-ssr-lite.internal.trusted-local-origin')

export const attachSsrTrustedLocalOrigin = (request: object, origin: string): void => {
  Object.defineProperty(request, TRUSTED_LOCAL_ORIGIN, { value: origin })
}

export const readSsrTrustedLocalOrigin = (request: object): string | undefined =>
  (request as { [TRUSTED_LOCAL_ORIGIN]?: string })[TRUSTED_LOCAL_ORIGIN]
