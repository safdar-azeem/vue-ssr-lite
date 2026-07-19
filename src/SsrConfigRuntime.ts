import type { SsrConfig } from './SsrConfigTypes'

/** Identity helper for typed flat SSR configuration modules. */
export const defineSsrConfig = <T extends SsrConfig>(config: T): T => config
