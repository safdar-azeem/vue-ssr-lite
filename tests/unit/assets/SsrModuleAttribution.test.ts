import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSsrFrameworkSourceResolver } from '../../../src/assets/SsrModuleAttribution'
import { SSR_BROWSER_BOOTSTRAP_SOURCES } from '../../../src/browser/SsrBrowserBootstrap'

describe('Task 010 capability source provenance', () => {
  it('resolves repository, workspace symlinks and installed dist through the same source identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bootstrap-provenance-'))
    try {
      const sourceRoot = join(root, 'arbitrary-workspace-name')
      const installedRoot = join(root, 'consumer/node_modules/vue-ssr-lite')
      const linkedRoot = join(root, 'linked/node_modules/vue-ssr-lite')
      const modules = Object.fromEntries(Object.values(SSR_BROWSER_BOOTSTRAP_SOURCES).map((source, index) => [`chunks/output-${index}.mjs`, [source]]))
      for (const directory of [sourceRoot, installedRoot]) {
        await mkdir(join(directory, 'src'), { recursive: true })
        await mkdir(join(directory, 'dist'), { recursive: true })
        await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'vue-ssr-lite' }))
        await writeFile(join(directory, 'dist/module-attribution.json'), JSON.stringify({ version: 1, modules }))
      }
      await mkdir(join(root, 'linked/node_modules'), { recursive: true })
      await symlink(sourceRoot, linkedRoot)
      const identities = Object.values(SSR_BROWSER_BOOTSTRAP_SOURCES)
      const sourceIds = identities.map((source) => join(sourceRoot, 'src', source))
      const installedIds = Object.keys(modules).map((file) => join(installedRoot, 'dist', file))
      const linkedIds = Object.keys(modules).map((file) => join(linkedRoot, 'dist', file))
      const resolve = await createSsrFrameworkSourceResolver([...sourceIds, ...installedIds, ...linkedIds])
      for (let index = 0; index < identities.length; index++) {
        expect(resolve(sourceIds[index]!)).toEqual([identities[index]])
        expect(resolve(installedIds[index]!)).toEqual(resolve(sourceIds[index]!))
        expect(resolve(linkedIds[index]!)).toEqual(resolve(sourceIds[index]!))
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
