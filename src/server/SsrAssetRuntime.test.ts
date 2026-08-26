import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseSsrProductionAssetMetadata,
  serializeSsrProductionAssetMetadata,
} from '../SsrAssetMetadata'
import {
  isSsrProductionAssetNotModified,
  parseSsrClientAssetManifest,
  resolveSsrProductionAsset,
  resolveSsrImmutableAssetPaths,
} from './SsrAssetRuntime'

let root = ''

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

describe('production SSR asset routing', () => {
  it('rejects the complete private .vite namespace before filesystem access', async () => {
    const fileSystem = {
      realpath: vi.fn(),
      stat: vi.fn(),
    }
    const privatePaths = [
      { pathname: '/.vite/manifest.json' },
      { pathname: '/.vite/ssr-manifest.json' },
      { pathname: '/.vite/other-private-file.json' },
      { pathname: '/%2evite/manifest.json' },
      { pathname: '/.%76ite/ssr-manifest.json' },
      { pathname: '/.VITE/case-insensitive-alias.json' },
      { pathname: '/app/.vite/manifest.json', viteBase: '/app/' },
      { pathname: '/app/%2e%76ite%2fssr-manifest.json', viteBase: '/app/' },
    ]

    for (const probe of privatePaths) {
      await expect(
        resolveSsrProductionAsset({
          clientRoot: '/client',
          protectedTemplates: [],
          fileSystem: fileSystem as any,
          ...probe,
        }),
        probe.pathname
      ).resolves.toBeNull()
    }
    expect(fileSystem.realpath).not.toHaveBeenCalled()
    expect(fileSystem.stat).not.toHaveBeenCalled()
  })

  it('protects canonical template paths while serving genuine static files', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-assets-'))
    await mkdir(join(root, 'shells'), { recursive: true })
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'index.html'), 'managed index')
    await writeFile(join(root, 'shells', 'admin.html'), 'managed admin')
    await writeFile(join(root, 'other.html'), 'static html')
    await writeFile(join(root, 'assets', 'app.js'), 'static js')
    const protectedTemplates = ['./index.html', './shells/admin.html']

    const resolveAsset = (pathname: string) =>
      resolveSsrProductionAsset({
        clientRoot: root,
        pathname,
        protectedTemplates,
      })

    await expect(resolveAsset('/index.html')).resolves.toBeNull()
    await expect(resolveAsset('/./index.html')).resolves.toBeNull()
    await expect(
      resolveAsset('/shells/../shells/admin.html')
    ).resolves.toBeNull()

    const script = await resolveAsset('/assets/app.js')
    const unrelatedHtml = await resolveAsset('/other.html')
    expect(script).toMatchObject({
      size: 9,
      contentType: 'text/javascript; charset=utf-8',
      cacheControl: 'public, max-age=3600',
    })
    expect(script).not.toHaveProperty('body')
    expect(unrelatedHtml).toMatchObject({
      size: 11,
      contentType: 'text/html; charset=utf-8',
    })
  })

  it('uses authoritative Vite output metadata for immutable cache policy', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-assets-'))
    await mkdir(join(root, 'assets', 'nested'), { recursive: true })
    await writeFile(join(root, 'assets', 'app-DG71SDF2.js'), 'hashed')
    await writeFile(join(root, 'assets', 'robots-generated.txt'), 'mutable')
    await writeFile(join(root, 'assets', 'report-version2.js'), 'mutable')
    await writeFile(join(root, 'assets', 'release-build123.js'), 'mutable')
    await writeFile(join(root, 'assets', 'application-production1.css'), 'mutable')
    await writeFile(join(root, 'assets', 'nested', 'site.css'), 'css')
    const manifestAssets = parseSsrClientAssetManifest(
      JSON.stringify({
        'src/main.ts': {
          file: 'assets/app-DG71SDF2.js',
          css: ['assets/nested/site.css'],
        },
        'public/report-version2.js': {
          file: 'assets/report-version2.js',
        },
        'public/release-build123.js': {
          file: 'assets/release-build123.js',
        },
        'public/application-production1.css': {
          file: 'assets/application-production1.css',
        },
      })
    )
    const revisionedAssets = parseSsrProductionAssetMetadata(
      serializeSsrProductionAssetMetadata([
        'assets/app-DG71SDF2.js',
        'assets/nested/site.css',
      ])
    )
    const immutableAssetPaths = resolveSsrImmutableAssetPaths(
      manifestAssets,
      revisionedAssets
    )

    const resolveAsset = (pathname: string, viteBase: string) =>
      resolveSsrProductionAsset({
        clientRoot: root,
        pathname,
        protectedTemplates: [],
        viteBase,
        immutableAssetPaths,
      })

    await expect(
      resolveAsset('/assets/app-DG71SDF2.js', '/')
    ).resolves.toMatchObject({
      size: 6,
      cacheControl: 'public, max-age=31536000, immutable',
    })
    await expect(
      resolveAsset('/products/assets/app-DG71SDF2.js', '/products/')
    ).resolves.toMatchObject({
      size: 6,
      cacheControl: 'public, max-age=31536000, immutable',
    })
    await expect(
      resolveAsset(
        '/products/assets/nested/site.css',
        'https://cdn.example.com/products/'
      )
    ).resolves.toMatchObject({ contentType: 'text/css; charset=utf-8' })
    await expect(
      resolveAsset('/products/assets/robots-generated.txt', '/products/')
    ).resolves.toMatchObject({ cacheControl: 'public, max-age=3600' })
    for (const filename of [
      'report-version2.js',
      'release-build123.js',
      'application-production1.css',
    ]) {
      await expect(
        resolveAsset(`/products/assets/${filename}`, '/products/')
      ).resolves.toMatchObject({ cacheControl: 'public, max-age=3600' })
    }
  })

  it('rejects traversal, backslashes, controls, directories, and symlink escapes', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-assets-'))
    const clientRoot = join(root, 'client')
    await mkdir(join(clientRoot, 'assets'), { recursive: true })
    await writeFile(join(root, 'secret.txt'), 'secret')
    await symlink(join(root, 'secret.txt'), join(clientRoot, 'assets', 'escape'))
    const resolveAsset = (pathname: string) =>
      resolveSsrProductionAsset({
        clientRoot,
        pathname,
        protectedTemplates: [],
      })

    for (const pathname of [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/assets/%2E%2E/private',
      '/assets/%2e%2e%2fsecret.txt',
      '/assets/%5c..%5csecret.txt',
      '/assets/..\\secret.txt',
      '/assets/%00bad.txt',
      '/assets/%E0%A4%A',
      '/assets/escape',
      '/assets/',
    ]) {
      await expect(resolveAsset(pathname), pathname).resolves.toBeNull()
    }
  })

  it('protects template aliases and supports encoded spaces and Unicode names', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-assets-'))
    await writeFile(join(root, 'index.html'), 'template')
    await symlink(join(root, 'index.html'), join(root, 'template-alias.html'))
    await writeFile(join(root, 'hello world.未知'), 'binary-safe')

    await expect(
      resolveSsrProductionAsset({
        clientRoot: root,
        pathname: '/template-alias.html',
        protectedTemplates: ['index.html'],
      })
    ).resolves.toBeNull()
    await expect(
      resolveSsrProductionAsset({
        clientRoot: root,
        pathname: '/hello%20world.%E6%9C%AA%E7%9F%A5',
        protectedTemplates: [],
      })
    ).resolves.toMatchObject({
      size: 11,
      contentType: 'application/octet-stream',
    })
  })

  it('evaluates ETag before If-Modified-Since and supports weak/list validators', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-assets-'))
    await writeFile(join(root, 'asset.txt'), 'validator')
    const asset = await resolveSsrProductionAsset({
      clientRoot: root,
      pathname: '/asset.txt',
      protectedTemplates: [],
    })
    expect(asset).not.toBeNull()
    expect(asset!.etag).toMatch(/^W\/"[a-f\d]+-[a-f\d]+"$/)

    expect(
      isSsrProductionAssetNotModified(asset!, {
        'if-none-match': `"unrelated", ${asset!.etag}`,
      })
    ).toBe(true)
    expect(
      isSsrProductionAssetNotModified(asset!, {
        'if-none-match': asset!.etag.slice(2),
      })
    ).toBe(true)
    expect(
      isSsrProductionAssetNotModified(asset!, {
        'if-none-match': '"stale"',
        'if-modified-since': asset!.lastModified,
      })
    ).toBe(false)
    expect(
      isSsrProductionAssetNotModified(asset!, {
        'if-modified-since': asset!.lastModified,
      })
    ).toBe(true)
    expect(
      isSsrProductionAssetNotModified(asset!, {
        'if-modified-since': new Date(0).toUTCString(),
      })
    ).toBe(false)
  })

  it('returns null only for expected unavailable filesystem errors', async () => {
    const options = {
      clientRoot: '/client',
      pathname: '/asset.js',
      protectedTemplates: [],
    }
    const failingFileSystem = (error: Error) => ({
      realpath: vi.fn().mockRejectedValue(error),
      stat: vi.fn(),
    })
    const filesystemError = (code: string) =>
      Object.assign(new Error(code), { code })

    for (const code of ['ENOENT', 'ENOTDIR']) {
      await expect(
        resolveSsrProductionAsset({
          ...options,
          fileSystem: failingFileSystem(filesystemError(code)) as any,
        })
      ).resolves.toBeNull()
    }
    for (const code of ['EACCES', 'EIO', 'EMFILE']) {
      await expect(
        resolveSsrProductionAsset({
          ...options,
          fileSystem: failingFileSystem(filesystemError(code)) as any,
        })
      ).rejects.toMatchObject({ code })
    }

    const abortError = new DOMException('filesystem aborted', 'AbortError')
    await expect(
      resolveSsrProductionAsset({
        ...options,
        fileSystem: failingFileSystem(abortError) as any,
      })
    ).rejects.toBe(abortError)

    const controller = new AbortController()
    controller.abort(new Error('request cancelled'))
    await expect(
      resolveSsrProductionAsset({ ...options, signal: controller.signal })
    ).rejects.toThrow('request cancelled')
  })
})
