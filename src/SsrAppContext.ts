import type { App } from 'vue'
import type { Router } from 'vue-router'
import type { SsrHydrationContext } from './SsrHydrationRuntime'

/**
 * Context passed to the default export of `main.ts`.
 *
 * Core owns `createApp` / `createSSRApp`, routing history, hydration, and
 * mounting. `main.ts` only installs plugins, providers, and global CSS.
 */
export interface AppContext {
  app: App
  router: Router | null
  server: boolean
  hydration: SsrHydrationContext
}

export type AppInitializer = (context: AppContext) => void | Promise<void>
