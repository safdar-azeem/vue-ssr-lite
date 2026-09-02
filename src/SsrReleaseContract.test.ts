import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  name: string
  version: string
  description?: string
  license?: string
  type?: string
  main?: string
  module?: string
  types?: string
  sideEffects?: boolean
  repository?:
    | string
    | {
        type: string
        url: string
      }
  homepage?: string
  bugs?: string
  files?: string[]
  bin?: Record<string, string>
  exports?: Record<
    string,
    { types?: string; import?: string; default?: string }
  >
  scripts?: Record<string, string>
  engines?: Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
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

    expect(manifest.name).toBe('vue-ssr-lite')
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    expect(manifest.license).toBe('MIT')
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/safdar-azeem/vue-ssr-lite.git',
    })
    expect(manifest.homepage).toBe(
      'https://github.com/safdar-azeem/vue-ssr-lite#readme'
    )
    expect(manifest.bugs).toBe(
      'https://github.com/safdar-azeem/vue-ssr-lite/issues'
    )
    expect(manifest.type).toBe('module')
    expect(manifest.main).toBe('./dist/index.mjs')
    expect(manifest.module).toBe('./dist/index.mjs')
    expect(manifest.types).toBe('./dist/index.d.ts')
    expect(manifest.sideEffects).toBe(false)
    expect(manifest.files).toEqual(['dist', 'README.md', 'LICENSE'])
    expect(manifest.bin).toEqual({
      'vue-ssr-lite': 'dist/cli.mjs',
    })
    expect(manifest.exports).toEqual({
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.mjs',
        default: './dist/index.mjs',
      },
      './client': {
        types: './dist/client.d.ts',
        import: './dist/client.mjs',
        default: './dist/client.mjs',
      },
      './server': {
        types: './dist/server.d.ts',
        import: './dist/server.mjs',
        default: './dist/server.mjs',
      },
      './vite': {
        types: './dist/vite.d.ts',
        import: './dist/vite.mjs',
        default: './dist/vite.mjs',
      },
    })
    expect(manifest.engines?.node).toBe('^20.19.0 || >=22.12.0')
    expect(manifest.peerDependencies).toMatchObject({
      vite: '^7.0.0',
      vue: '^3.5.0',
      'vue-router': '^4.6.0',
    })
    for (const range of Object.values({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    })) {
      expect(range).not.toMatch(/^(?:file|link|workspace):/)
    }
    for (const dependency of [
      'vite',
      'vue',
      'vue-router',
      '@vue/server-renderer',
    ]) {
      expect(manifest.dependencies).not.toHaveProperty(dependency)
    }
    expect(manifest.peerDependencies).not.toHaveProperty('@vue/server-renderer')
    for (const applicationDependency of [
      '@apollo/client',
      '@vue/apollo-composable',
      'graphql',
      'vue-apollo-client',
    ]) {
      expect(manifest.dependencies).not.toHaveProperty(applicationDependency)
      expect(manifest.peerDependencies).not.toHaveProperty(
        applicationDependency
      )
    }
    expect(manifest.dependencies).toMatchObject({
      'es-module-lexer': expect.any(String),
      esbuild: expect.any(String),
    })
    expect(manifest.devDependencies).toMatchObject({
      '@vitejs/plugin-vue': expect.any(String),
      vite: expect.any(String),
      vue: expect.any(String),
      'vue-router': expect.any(String),
    })
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

  it('maps every README package import to an explicit public export', async () => {
    const [manifest, readme] = await Promise.all([
      readJson<PackageManifest>(join(repositoryRoot, 'package.json')),
      readFile(join(repositoryRoot, 'README.md'), 'utf8'),
    ])
    const specifiers = new Set(
      [...readme.matchAll(/\bfrom\s+['"](vue-ssr-lite(?:\/[^'"]+)?)['"]/g)].map(
        (match) => match[1]
      )
    )

    expect(specifiers).toEqual(
      new Set(['vue-ssr-lite', 'vue-ssr-lite/server', 'vue-ssr-lite/vite'])
    )
    for (const specifier of specifiers) {
      const exportKey =
        specifier === 'vue-ssr-lite'
          ? '.'
          : `./${specifier.slice('vue-ssr-lite/'.length)}`
      expect(
        Object.prototype.hasOwnProperty.call(manifest.exports, exportKey),
        `${specifier} must map to package.json exports[${exportKey}]`
      ).toBe(true)
    }
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
