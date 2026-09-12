import { inject, type InjectionKey } from 'vue'
import type { SsrRequestContext } from './SsrRuntimeTypes'

/** Shared by the managed server, Vite graph and browser integrations. */
export const SSR_REQUEST_CONTEXT = Symbol.for('vue-ssr:request-context') as InjectionKey<
  SsrRequestContext<any, any>
>

export const useSsrRequestContext = <
  TApplicationState = Record<string, unknown>,
  TPublicConfig = unknown,
>(): SsrRequestContext<TApplicationState, TPublicConfig> => {
  const context = inject(SSR_REQUEST_CONTEXT)
  if (!context) throw new Error('vue-ssr-lite request context is not installed.')
  return context as SsrRequestContext<TApplicationState, TPublicConfig>
}

/** Application-owned absolute URLs use Core's resolved canonical origin. */
export const useOrigin = (): string => useSsrRequestContext().siteOrigin
