import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseSsrCliArguments } from './SsrCliOptions'

let root = ''
let alias = ''

afterEach(async () => {
  if (alias) await rm(alias, { recursive: true, force: true })
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
  alias = ''
})

describe('parseSsrCliArguments', () => {
  it('start loads baked runtime without requiring ssr.config in cwd', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-start-'))
    const serverDir = join(root, 'dist', 'server')
    await mkdir(serverDir, { recursive: true })
    await writeFile(join(serverDir, 'SsrRuntime.js'), 'export default {}\n')

    const options = await parseSsrCliArguments(['start', '--root', root])

    expect(options.command).toBe('start')
    expect(options.config).toBeUndefined()
    expect(options.serverOutput).toBe(
      resolve(await realpath(root), 'dist/server/SsrRuntime.js')
    )
  })

  it('start accepts a custom --server-output path', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-start-custom-'))
    const custom = join(root, 'out', 'runtime.mjs')
    await mkdir(join(root, 'out'), { recursive: true })
    await writeFile(custom, 'export default {}\n')

    const options = await parseSsrCliArguments([
      'start',
      '--root',
      root,
      '--server-output',
      'out/runtime.mjs',
    ])

    expect(options.serverOutput).toBe(await realpath(custom))
    expect(options.config).toBeUndefined()
  })

  it('start fails clearly when the baked runtime is missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-start-missing-'))

    await expect(parseSsrCliArguments(['start', '--root', root])).rejects.toThrow(
      /could not find the production SSR runtime/
    )
  })

  it('dev accepts a convention-based project without ssr.config', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-dev-'))

    const options = await parseSsrCliArguments(['dev', '--root', root])
    expect(options.command).toBe('dev')
    expect(options.config).toBeUndefined()
  })

  it('build resolves an existing ssr.config', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-build-'))
    await writeFile(join(root, 'ssr.config.mjs'), 'export default {}\n')

    const options = await parseSsrCliArguments(['build', '--root', root])

    expect(options.command).toBe('build')
    expect(options.config).toBe(resolve(await realpath(root), 'ssr.config.mjs'))
  })

  it('canonicalizes a symlinked project root before Vite owns lifecycle resources', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-root-'))
    alias = `${root}-alias`
    await symlink(root, alias)

    const options = await parseSsrCliArguments(['dev', '--root', alias])

    expect(options.root).toBe(await realpath(root))
  })
})
