import type { InjectionKey } from 'vue'
import type { SsrNavigationRuntime } from './SsrNavigationTypes'

export const SSR_NAVIGATION_RUNTIME: InjectionKey<SsrNavigationRuntime> =
  Symbol('vue-ssr-lite navigation runtime')
