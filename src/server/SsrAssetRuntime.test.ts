import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSsrProductionAsset } from './SsrAssetRuntime'

let root = ''

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

describe('production SSR asset routing', () => {
  it('protects canonical template paths while serving genuine static files', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-assets-'))
    await mkdir(join(root, 'shells'), { recursive: true })
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'index.html'), 'managed index')
    await writeFile(join(root, 'shells', 'admin.html'), 'managed admin')
    await writeFile(join(root, 'other.html'), 'static html')
    await writeFile(join(root, 'assets', 'app.js'), 'static js')
    const protectedTemplates = ['./index.html', './shells/admin.html']

    await expect(
      resolveSsrProductionAsset(root, '/index.html', protectedTemplates)
    ).resolves.toBeNull()
    await expect(
      resolveSsrProductionAsset(root, '/./index.html', protectedTemplates)
    ).resolves.toBeNull()
    await expect(
      resolveSsrProductionAsset(
        root,
        '/shells/../shells/admin.html',
        protectedTemplates
      )
    ).resolves.toBeNull()

    const script = await resolveSsrProductionAsset(
      root,
      '/assets/app.js',
      protectedTemplates
    )
    const unrelatedHtml = await resolveSsrProductionAsset(
      root,
      '/other.html',
      protectedTemplates
    )
    expect(new TextDecoder().decode(script?.body as Uint8Array)).toBe('static js')
    expect(script?.headers?.['cache-control']).toContain('immutable')
    expect(new TextDecoder().decode(unrelatedHtml?.body as Uint8Array)).toBe(
      'static html'
    )
    await expect(
      resolveSsrProductionAsset(root, '/%2e%2e/secret.txt', protectedTemplates)
    ).resolves.toBeNull()
  })
})
