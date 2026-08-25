import { isRunnableDevEnvironment, type ViteDevServer } from 'vite'

const NON_RUNNABLE_SSR_ENVIRONMENT_ERROR =
  'vue-ssr-lite development SSR requires a Vite RunnableDevEnvironment for the "ssr" environment because server-side application modules must execute in the Node runtime.'

/** Import a server module through the ModuleRunner owned by Vite's SSR environment. */
export const importSsrViteModule = async <T = Record<string, unknown>>(
  server: ViteDevServer,
  specifier: string
): Promise<T> => {
  const environment = server.environments.ssr
  if (!isRunnableDevEnvironment(environment)) {
    throw new Error(NON_RUNNABLE_SSR_ENVIRONMENT_ERROR)
  }
  return environment.runner.import<T>(specifier)
}
