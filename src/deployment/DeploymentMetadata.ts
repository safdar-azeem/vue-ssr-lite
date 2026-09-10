import type { SsrNormalizedConfig } from '../SsrConfigCompileRuntime'
import { compileServerRoutes } from '../server-routes/SsrServerRouteRuntime'

export const DEPLOYMENT_METADATA_PATH = '.vite/vue-ssr-lite-deployment.json'

/** Build facts only: no environment values, handlers, host tables or private config. */
export interface DeploymentMetadata {
  version: 1
  viteBase: string
  templates: string[]
  dynamicAssets: boolean
  serverRouteMatchers: string[]
  controlPaths: string[]
}

export const createDeploymentMetadata = (config: SsrNormalizedConfig, viteBase: string): DeploymentMetadata => {
  const applications = Object.values(config.applications)
  return {
    version: 1,
    viteBase,
    templates: [...new Set(applications.map((app) => app.template))].sort(),
    // Opaque middleware and legacy match functions cannot be projected safely.
    // Native Server Route matchers come from Core's compiler, not an adapter router.
    dynamicAssets: Boolean(config.serverMiddleware?.length || applications.some((app) => app.endpoints?.length)),
    serverRouteMatchers: [...new Set(applications.flatMap((app) => {
      const routes = compileServerRoutes(app.serverRoutes, config.server)
      return [...Object.values(routes.staticRoutes), ...routes.dynamicRoutes].map((route) => route.matcher.source)
    }))].sort(),
    controlPaths: [config.server?.healthPath || '/healthz', config.server?.readinessPath || '/readyz'],
  }
}

export const parseDeploymentMetadata = (source: string): DeploymentMetadata => {
  const value = JSON.parse(source) as Partial<DeploymentMetadata>
  if (!value || value.version !== 1 || typeof value.viteBase !== 'string' ||
      typeof value.dynamicAssets !== 'boolean' ||
      ![value.templates, value.serverRouteMatchers, value.controlPaths].every((list) =>
        Array.isArray(list) && list.every((item) => typeof item === 'string'))) {
    throw new Error('[vue-ssr-lite] Invalid deployment build metadata. Rebuild client and server together.')
  }
  return value as DeploymentMetadata
}
