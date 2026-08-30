import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  version: string
  type?: string
  scripts?: Record<string, string>
  engines?: Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const examples = [
  '1-single-app',
  '2-hybrid-route-app',
  '3-multi-domain-apps',
] as const

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, 'utf8')) as T

describe('repository release contract', () => {
  it('keeps the package architecture and full prepublish gate explicit', async () => {
    const manifest = await readJson<PackageManifest>(
      join(repositoryRoot, 'package.json')
    )

    expect(manifest.type).toBe('module')
    expect(manifest.engines?.node).toBe('>=22.12.0')
    expect(manifest.peerDependencies).toMatchObject({
      vite: '^7.0.0',
      vue: '^3.5.0',
      'vue-router': '^4.6.0',
    })
    for (const dependency of [
      'vite',
      'vue',
      'vue-router',
      '@vue/server-renderer',
    ]) {
      expect(manifest.dependencies).not.toHaveProperty(dependency)
    }
    expect(manifest.peerDependencies).not.toHaveProperty('@vue/server-renderer')
    expect(manifest.scripts?.prepublishOnly).toBe(
      'npm run build && npm test && npm run test:package'
    )
  })

  it('publishes release candidates to next and stable releases to latest', async () => {
    const manifest = await readJson<PackageManifest>(
      join(repositoryRoot, 'package.json')
    )

    expect(manifest.scripts?.['release:rc']).toBe(
      'npm version prerelease --preid=rc && npm publish --tag next'
    )
    expect(manifest.scripts?.['release:patch']).toBe(
      'npm version patch && npm publish --tag latest'
    )
    expect(manifest.scripts?.['release:minor']).toBe(
      'npm version minor && npm publish --tag latest'
    )
    expect(manifest.scripts?.['release:major']).toBe(
      'npm version major && npm publish --tag latest'
    )
  })

  it('keeps primary examples synchronized with the repository version', async () => {
    const manifest = await readJson<PackageManifest>(
      join(repositoryRoot, 'package.json')
    )

    for (const example of examples) {
      const exampleRoot = join(repositoryRoot, 'examples', example)
      const exampleManifest = await readJson<{
        dependencies?: Record<string, string>
      }>(join(exampleRoot, 'package.json'))
      const lockfile = await readFile(join(exampleRoot, 'yarn.lock'), 'utf8')

      expect(exampleManifest.dependencies?.['vue-ssr-lite']).toBe(
        manifest.version
      )
      expect(lockfile).toContain(`vue-ssr-lite@${manifest.version}:`)
      expect(lockfile).not.toContain('vue-ssr-lite@1.0.0-rc.1:')
    }
  })
})
