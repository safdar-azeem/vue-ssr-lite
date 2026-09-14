import { existsSync } from 'node:fs'
import { dirname, extname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const resolveTypeScriptCandidate = (parentUrl, specifier) => {
  const bare = specifier.split(/[?#]/, 1)[0] || specifier
  if (extname(bare)) return undefined
  const base = resolvePath(dirname(fileURLToPath(parentUrl)), bare)
  const file = `${base}.ts`
  if (existsSync(file)) return pathToFileURL(file).href
  const index = resolvePath(base, 'index.ts')
  return existsSync(index) ? pathToFileURL(index).href : undefined
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (!context.parentURL || !specifier.startsWith('.')) throw error
    const url = resolveTypeScriptCandidate(context.parentURL, specifier)
    if (!url) throw error
    return { url, shortCircuit: true }
  }
}
