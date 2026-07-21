import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseSsrCliArguments } from './SsrCliOptions'

let root = ''

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
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
    expect(options.serverOutput).toBe(resolve(root, 'dist/server/SsrRuntime.js'))
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

    expect(options.serverOutput).toBe(custom)
    expect(options.config).toBeUndefined()
  })

  it('start fails clearly when the baked runtime is missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-start-missing-'))

    await expect(parseSsrCliArguments(['start', '--root', root])).rejects.toThrow(
      /could not find the production SSR runtime/
    )
  })

  it('dev still requires ssr.config discovery', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-dev-'))

    await expect(parseSsrCliArguments(['dev', '--root', root])).rejects.toThrow(
      /could not find an SSR config/
    )
  })

  it('build resolves an existing ssr.config', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-build-'))
    await writeFile(join(root, 'ssr.config.mjs'), 'export default {}\n')

    const options = await parseSsrCliArguments(['build', '--root', root])

    expect(options.command).toBe('build')
    expect(options.config).toBe(resolve(root, 'ssr.config.mjs'))
  })
})
