import { existsSync } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Production build artifacts (templates, manifests, private metadata) are
 * immutable for a process or Worker isolate. Hosts without a project
 * filesystem, such as Cloudflare Workers, register the embedded build output
 * once before initialization. Request-specific data never belongs here.
 */
const REGISTRY = Symbol.for('vue-ssr-lite.embedded-production-files')
const values = globalThis as unknown as Record<PropertyKey, unknown>

const embedded = (): ReadonlyMap<string, string> | undefined =>
  values[REGISTRY] as ReadonlyMap<string, string> | undefined

const key = (path: string) => resolve(path).replaceAll('\\', '/')

/** Register immutable build output keyed by absolute path. Repeated identical registration is a no-op. */
export const registerSsrEmbeddedProductionFiles = (files: Readonly<Record<string, string>>): void => {
  const current = embedded()
  if (current) return
  values[REGISTRY] = new Map(Object.entries(files).map(([path, source]) => [key(path), source]))
}

const notFound = (path: string) =>
  Object.assign(new Error(`ENOENT: no such embedded production file, open '${path}'`), { code: 'ENOENT' })

export const readSsrProductionText = async (path: string, signal?: AbortSignal): Promise<string> => {
  const files = embedded()
  if (!files) return readFile(path, { encoding: 'utf8', signal })
  signal?.throwIfAborted()
  const source = files.get(key(path))
  if (source === undefined) throw notFound(path)
  return source
}

export const ssrProductionFileExistsSync = (path: string): boolean => {
  const files = embedded()
  return files ? files.has(key(path)) : existsSync(path)
}

export const ssrProductionFileExists = async (path: string): Promise<boolean> => {
  const files = embedded()
  if (files) return files.has(key(path))
  try { await access(path); return true } catch { return false }
}

export const isSsrProductionFile = async (path: string): Promise<boolean> => {
  const files = embedded()
  if (files) {
    if (!files.has(key(path))) throw notFound(path)
    return true
  }
  return (await stat(path)).isFile()
}

export const realSsrProductionPath = async (path: string): Promise<string> =>
  embedded() ? key(path) : realpath(path)
