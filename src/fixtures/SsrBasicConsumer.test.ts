import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/basic-consumer'
)

describe('basic consumer fixture', () => {
  it('declares only root and routes', async () => {
    const main = await readFile(join(fixtureRoot, 'src/main.ts'), 'utf8')
    expect(main).toContain('defineApplication({')
    expect(main).toContain('root: App')
    expect(main).toContain('routes:')
    expect(main).not.toContain('extensions')
    expect(main).not.toContain('entry-client')
    expect(main).not.toContain('entry-server')
    expect(main).not.toContain('seoExtension')
  })
})
