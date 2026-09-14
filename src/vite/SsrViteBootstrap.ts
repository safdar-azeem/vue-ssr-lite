import type { Rollup, ResolvedConfig } from 'vite'
import { isViteStylesheetModule } from './SsrViteAssetRuntime'
import { SSR_BROWSER_BOOTSTRAP_SOURCES, type SsrBrowserBootstrapCapability } from '../browser/SsrBrowserBootstrap'
import { isSsrBootstrapAssetPath, parseSsrBootstrapAssetManifest, type SsrBootstrapAssetManifest, type SsrBootstrapPreloadPolicy } from '../assets/SsrBootstrapAssetRuntime'

/** Request-selected SSR hints have no equivalent Vite HTML import host.
 * Fail safe for policies whose host/path semantics we cannot reproduce. Never
 * call, wrap, overwrite or serialize the consumer's callbacks. */
export const resolveSsrBootstrapPreloadPolicy = (config: { build: Pick<ResolvedConfig['build'], 'modulePreload'>; experimental?: Pick<ResolvedConfig['experimental'], 'renderBuiltUrl'> }): SsrBootstrapPreloadPolicy => {
  if (config.build.modulePreload === false) return 'disabled'
  if (typeof config.build.modulePreload === 'object' && config.build.modulePreload.resolveDependencies) return 'resolve-dependencies'
  if (config.experimental?.renderBuiltUrl) return 'render-built-url'
  return 'enabled'
}

export interface SsrBootstrapBuildApplication {
  id: string
  clientModuleId: string
  initial: readonly SsrBrowserBootstrapCapability[]
}

/** Map semantic source boundaries onto Rollup's emitted JS graph. This also
 * accepts the Task 010 audit's source resolver for identical packed coverage. */
export const createSsrBootstrapAssetManifest = (
  bundle: Rollup.OutputBundle,
  applications: readonly SsrBootstrapBuildApplication[],
  sources: (id: string) => readonly string[],
  policy: SsrBootstrapPreloadPolicy = 'enabled'
): SsrBootstrapAssetManifest => {
  const chunks = new Map(Object.values(bundle).flatMap((chunk) =>
    chunk.type === 'chunk' ? [[chunk.fileName, chunk] as const] : []))
  const closure = (seeds: readonly string[], dynamic: boolean): Set<string> => {
    const visited = new Set<string>()
    const visit = (file: string) => {
      const chunk = chunks.get(file)
      if (!chunk || visited.has(file)) return
      visited.add(file)
      chunk.imports.forEach(visit)
      if (dynamic) chunk.dynamicImports.forEach(visit)
    }
    seeds.forEach(visit)
    return visited
  }
  const output: Record<string, { initial: readonly SsrBrowserBootstrapCapability[]; capabilities: Partial<Record<SsrBrowserBootstrapCapability, string[]>> }> = Object.create(null)
  for (const application of [...applications].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const entryFiles = [...chunks.values()].filter((chunk) =>
      chunk.facadeModuleId === application.clientModuleId || Object.hasOwn(chunk.modules, application.clientModuleId)
    ).map((chunk) => chunk.fileName)
    const entryStatic = closure(entryFiles, false)
    const available = closure(entryFiles, true)
    const capabilities: Partial<Record<SsrBrowserBootstrapCapability, string[]>> = Object.create(null)
    if (policy === 'enabled') for (const [key, source] of Object.entries(SSR_BROWSER_BOOTSTRAP_SOURCES)) {
      const roots = [...chunks.values()].filter((chunk) => available.has(chunk.fileName) &&
        Object.entries(chunk.modules).some(([id, module]) => module.renderedLength > 0 && sources(id).includes(source))
      ).map((chunk) => chunk.fileName)
      // Walk static edges only. Dynamic descendants and other app entries are
      // never seeds. Consumer manual chunking may legitimately share roots.
      capabilities[key as SsrBrowserBootstrapCapability] = [...closure(roots, false)]
        .filter((file) => !entryStatic.has(file) && isSsrBootstrapAssetPath(file) &&
          // Vite removes empty pure-CSS chunks in its generateBundle hook.
          Boolean(chunks.get(file)!.code.trim()) &&
          !(chunks.get(file)!.exports.length === 0 &&
            Object.keys(chunks.get(file)!.modules).length > 0 &&
            Object.keys(chunks.get(file)!.modules).every(isViteStylesheetModule)))
        .sort()
    }
    output[application.id] = { initial: application.initial, capabilities }
  }
  // Use the runtime validator here too: persisted metadata contains public
  // file identities only, not module IDs, roots, functions or configuration.
  return parseSsrBootstrapAssetManifest(JSON.stringify({ version: 1, policy, applications: output }))
}
