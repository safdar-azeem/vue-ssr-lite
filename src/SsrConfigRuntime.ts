import type { ServerConfig } from './SsrConfigTypes'

/** Identity helper for typed `server.ts` modules. */
export const defineServer = <T extends ServerConfig>(config: T): T => config
