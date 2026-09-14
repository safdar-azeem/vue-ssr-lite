import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export interface SsrModuleAttributionOptions {
  moduleSources?: Record<string, string[]>
}

/** Task 010 source/package identity mapping, shared by audits and bootstrap builds. */
export const frameworkModuleSources = (id: string, frameworkRoot: string, options: SsrModuleAttributionOptions = {}): string[] => {
  const path = id.replaceAll('\\', '/').split('?', 1)[0]!
  const root = frameworkRoot.replaceAll('\\', '/').replace(/\/$/, '')
  if (path.startsWith(`${root}/src/`)) return [path.slice(`${root}/src/`.length)]
  const distribution = path.startsWith(`${root}/dist/`)
    ? path.slice(`${root}/dist/`.length)
    : path.split('/node_modules/vue-ssr-lite/dist/')[1]
  return distribution ? options.moduleSources?.[distribution] ?? [] : []
}

/** Build-only discovery from actual module package scopes; no checkout assumptions. */
export const createSsrFrameworkSourceResolver = async (ids: readonly string[]) => {
  type Scope = { root: string; moduleSources?: Record<string, string[]> }
  const scopes = new Map<string, Promise<Scope | undefined>>()
  const scopeFor = (directory: string): Promise<Scope | undefined> => {
    const existing = scopes.get(directory)
    if (existing) return existing
    const work = (async () => {
      try {
        const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
        if (manifest.name === 'vue-ssr-lite') {
          let moduleSources: Record<string, string[]> | undefined
          try {
            const attribution = JSON.parse(await readFile(resolve(directory, 'dist/module-attribution.json'), 'utf8'))
            if (attribution.version !== 1 || !attribution.modules || typeof attribution.modules !== 'object' || Array.isArray(attribution.modules) ||
                Object.entries(attribution.modules).some(([file, sources]) =>
                  !safeIdentity(file) || !Array.isArray(sources) || !sources.every(safeIdentity))) {
              throw new Error('Invalid vue-ssr-lite package module attribution.')
            }
            moduleSources = attribution.modules
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          return { root: directory, moduleSources }
        }
        // A dependency's package scope cannot belong to the framework.
        return undefined
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const parent = dirname(directory)
      return parent === directory ? undefined : scopeFor(parent)
    })()
    scopes.set(directory, work)
    return work
  }
  const sources = new Map<string, string[]>()
  await Promise.all(ids.filter((id) => !id.startsWith('\0') && /^(?:\/|[A-Za-z]:[\\/])/.test(id)).map(async (id) => {
    const scope = await scopeFor(dirname(id.split('?', 1)[0]!))
    if (scope) sources.set(id, frameworkModuleSources(id, scope.root, scope))
  }))
  return (id: string): readonly string[] => sources.get(id) ?? []
}

const safeIdentity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !/[\\:%?\u0000-\u0020]/.test(value) &&
  value.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..')
