import { inject, type InjectionKey } from 'vue'
import type { SsrRequestContext } from './SsrRuntimeTypes'

/**
 * Cross-package-stable request-context injection key.
 *
 * The managed server and a Vite-loaded consumer application can evaluate
 * `vue-ssr-lite` through different module graphs. The global symbol registry
 * keeps the provider and consumer identities equal across those evaluations.
 */
export const SSR_REQUEST_CONTEXT = Symbol.for(
  'vue-ssr:request-context'
) as InjectionKey<SsrRequestContext<any, any, any>>

export const useSsrRequestContext = <
  TApplicationState = Record<string, unknown>,
  TPublicConfig = unknown,
  TExtension = unknown,
>(): SsrRequestContext<TApplicationState, TPublicConfig, TExtension> => {
  const context = inject(SSR_REQUEST_CONTEXT)
  if (!context) throw new Error('vue-ssr-lite request context is not installed.')
  return context as SsrRequestContext<
    TApplicationState,
    TPublicConfig,
    TExtension
  >
}
