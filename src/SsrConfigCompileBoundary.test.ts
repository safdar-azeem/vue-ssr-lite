import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectApplicationDeclarationFiles,
  resolveApplicationRoutesModule,
  type SsrConfigModuleGraph,
} from './SsrConfigCompileBoundary'

let root = ''

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

describe('application source discovery contract', () => {
  it('walks helper factories instead of stopping at defineApplication imports', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-discovery-'))
    await mkdir(join(root, 'src', 'website'), { recursive: true })
    await writeFile(
      join(root, 'src/factory.ts'),
      `import { defineApplication } from 'vue-ssr-lite'\nexport const createApp = (config) => defineApplication(config)\n`
    )
    await writeFile(
      join(root, 'src/website/app.ts'),
      `import { createApp } from '../factory'\nimport routes from './routes'\nexport default createApp({ name: 'website', routes })\n`
    )
    await writeFile(join(root, 'src/website/routes.ts'), 'export default []\n')
    await writeFile(
      join(root, 'server.ts'),
      `import website from './src/website/app'\nexport default { applications: [website] }\n`
    )
    const walked = await collectApplicationDeclarationFiles(
      join(root, 'server.ts'),
      0,
      new Set(),
      root
    )
    expect(walked.truncated).toBe(false)
    expect(walked.files.some((file) => file.endsWith('src/website/app.ts'))).toBe(true)
    expect(walked.files.some((file) => file.endsWith('src/factory.ts'))).toBe(true)
  })

  it('fails when an application imports more than one Vue-touching module', () => {
    const graph: SsrConfigModuleGraph = {
      imports: new Map([
        ['/app/src/website/app.ts', ['/app/src/website/routes.ts', '/app/src/website/pages.ts']],
      ]),
      universalImporters: new Set([
        '/app/src/website/routes.ts',
        '/app/src/website/pages.ts',
      ]),
    }
    expect(() =>
      resolveApplicationRoutesModule('/app/src/website/app.ts', graph, 'website')
    ).toThrow(/multiple Vue-touching modules/)
  })
})
