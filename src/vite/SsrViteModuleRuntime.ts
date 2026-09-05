import { isRunnableDevEnvironment, type EnvironmentModuleNode, type ViteDevServer } from 'vite'

// Import roots, not requests. Weak ownership lets Vite/server replacement
// release an entire revision without a global cache of module paths.
const importedRoots = new WeakMap<ViteDevServer, Set<string>>()

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
  const value = await environment.runner.import<T>(specifier)
  const evaluated = environment.runner.evaluatedModules.getModuleByUrl(specifier)
  const module = evaluated
    ? environment.moduleGraph.getModuleById(evaluated.id)
    : await environment.moduleGraph.getModuleByUrl(specifier)
  if (module?.id) {
    let roots = importedRoots.get(server)
    if (!roots) importedRoots.set(server, roots = new Set())
    roots.add(module.id)
  }
  return value
}

/** Snapshot Vite-owned invalidation and evaluation identities, never source
 * files or request state. Checking a revision performs no imports/transforms.
 * Include dependencies because an HMR acceptance boundary can stop invalidation
 * before it reaches an entry, and ModuleRunner replaces exports on reload. */
export const captureSsrViteRuntimeRevision = (
  server: ViteDevServer,
  loaded?: unknown
): (() => boolean) | undefined => {
  const environment = server.environments.ssr
  if (!isRunnableDevEnvironment(environment)) return undefined
  const graph = environment.moduleGraph
  const evaluated = environment.runner.evaluatedModules
  // Also recognize programmatic hosts that import through Vite directly.
  // This scan occurs only while preparing a revision, never on a warm request.
  const loadedModule = loaded === undefined ? undefined :
    [...evaluated.idToModuleMap.values()].find((module) =>
      module.exports === loaded || module.exports?.default === loaded
    )
  if (loaded !== undefined && !loadedModule) return undefined
  let roots = importedRoots.get(server)
  if (loadedModule) {
    if (!roots) importedRoots.set(server, roots = new Set())
    roots.add(loadedModule.id)
  }
  if (!roots?.size) return undefined
  const visited = new Set<EnvironmentModuleNode>()
  const checks: (() => boolean)[] = []
  const visit = (module: EnvironmentModuleNode) => {
    if (visited.has(module)) return
    visited.add(module)
    const id = module.id
    const invalidation = module.lastInvalidationTimestamp
    const hmr = module.lastHMRTimestamp
    const evaluation = id ? evaluated.getModuleById(id) : undefined
    const exports = evaluation?.exports
    checks.push(() =>
      (!id || graph.getModuleById(id) === module) &&
      module.lastInvalidationTimestamp === invalidation &&
      module.lastHMRTimestamp === hmr &&
      // Previously unevaluated lazy modules may execute on demand without
      // changing the configuration revision.
      (!evaluation || (evaluated.getModuleById(id!) === evaluation && evaluation.exports === exports))
    )
    for (const dependency of module.importedModules) visit(dependency)
  }
  for (const id of loadedModule ? [loadedModule.id] : roots) {
    const module = graph.getModuleById(id)
    if (!module) return undefined
    visit(module)
  }
  return () => server.environments.ssr === environment &&
    environment.runner.evaluatedModules === evaluated && checks.every((check) => check())
}
