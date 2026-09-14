import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sourceRoot = resolve(repositoryRoot, 'src')
const fixtureRoot = resolve(repositoryRoot, 'tests/fixtures')
const cleanConsumerStyle = resolve(fixtureRoot, 'clean-consumer/src/style.css')
const cleanConsumerLogo = resolve(fixtureRoot, 'clean-consumer/src/logo.svg')
const publicFacades = ['client.ts', 'index.ts', 'server.ts', 'vite.ts']
const obsoleteRoots = ['fixtures', 'scripts', 'src/fixtures', 'src/server-routes']
const prohibitedProductionRoots = new Set(['examples', 'fixtures', 'tests', 'tools'])

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      return /\.(?:[cm]?[jt]sx?|vue)$/.test(entry.name) ? [path] : []
    })
  )
  return files.flat()
}

const importedSpecifiers = (source: string): string[] =>
  [...source.matchAll(/\b(?:from|import)\s*(?:type\s*)?(?:\(\s*)?['"]([^'"]+)['"]/g)].map(
    (match) => match[1]
  )

describe('Task 016 repository layout', () => {
  it('keeps only the intentional public facades as root TypeScript source files', async () => {
    const entries = await readdir(sourceRoot, { withFileTypes: true })
    const rootTypescriptFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
      .sort()

    expect(rootTypescriptFiles).toEqual(publicFacades)
  })

  it('keeps fixtures in tests and prevents obsolete top-level roots from returning', async () => {
    await expect(access(fixtureRoot)).resolves.toBeUndefined()
    await expect(access(cleanConsumerLogo)).resolves.toBeUndefined()
    expect(await readFile(cleanConsumerStyle, 'utf8')).toContain("url('./logo.svg')")
    for (const obsoleteRoot of obsoleteRoots) {
      await expect(access(resolve(repositoryRoot, obsoleteRoot))).rejects.toThrow()
    }
  })

  it('keeps production source independent of tests, tooling, fixtures, and examples', async () => {
    for (const file of await sourceFiles(sourceRoot)) {
      const source = await readFile(file, 'utf8')
      for (const specifier of importedSpecifiers(source)) {
        if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue
        const target = specifier.startsWith('/')
          ? resolve(repositoryRoot, `.${specifier}`)
          : resolve(dirname(file), specifier)
        const projectPath = relative(repositoryRoot, target)
        const root = projectPath.split(/[\\/]/)[0]
        expect(prohibitedProductionRoots.has(root), `${file} imports ${specifier}`).toBe(false)
      }
    }
  })
})
