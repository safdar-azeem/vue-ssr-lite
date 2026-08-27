import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/basic-consumer'
)

describe('basic consumer fixture', () => {
  it('uses the conventional main.ts initializer and routes export', async () => {
    const main = await readFile(join(fixtureRoot, 'src/main.ts'), 'utf8')
    expect(main).toContain('export { routes }')
    expect(main).toContain('export default ({ app }: AppContext)')
    expect(main).not.toContain('defineApplication')
    expect(main).not.toContain('createApp')
    expect(main).not.toContain('createSSRApp')
    expect(main).not.toContain('entry-client')
    expect(main).not.toContain('entry-server')
  })
})
