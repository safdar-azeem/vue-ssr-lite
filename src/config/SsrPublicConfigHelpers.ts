import type { ApplicationConfig, ServerConfig } from './SsrConfigTypes'

const APPLICATION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

/** Typed identity helper for `server.ts`. */
export const defineServer = <T extends ServerConfig>(config: T): T => config

/** Typed identity helper for explicit application registration. */
export const defineApplication = <T extends ApplicationConfig>(config: T): T => {
  if (!config || typeof config !== 'object') {
    throw new Error('defineApplication() requires an application configuration object.')
  }
  const applicationName = config.name
  if (typeof applicationName !== 'string' || !APPLICATION_NAME.test(applicationName)) {
    throw new Error(
      'defineApplication() name must be a stable identifier matching /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.'
    )
  }
  if (config.render != null && config.render !== 'ssr' && config.render !== 'spa') {
    throw new Error(`Application "${applicationName}" render must be "ssr" or "spa".`)
  }
  if (config.routes && config.router) {
    throw new Error(`Application "${applicationName}" cannot declare both routes and router.`)
  }
  if (config.host != null && config.domain != null) {
    throw new Error(
      `Application "${applicationName}" cannot declare both "host" and "domain". Use "host" for simple static host matching or "domain" for environment-aware domain routing.`
    )
  }
  if ('serverMiddleware' in config && config.serverMiddleware !== undefined) {
    throw new Error('serverMiddleware belongs on defineServer(), not defineApplication().')
  }
  if ('port' in config && (config as { port?: unknown }).port != null) {
    throw new Error(
      `Application "${applicationName}" cannot declare a port. Use defineServer({ server: { port } }).`
    )
  }
  return config
}
