import { execFile as execFileCallback } from 'node:child_process'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export const assertPackedArtifact = ({ record, manifest, assert }) => {
  const files = new Set(record.files.map(({ path }) => path))
  const required = [
    'package.json',
    'README.md',
    'LICENSE',
    'dist/index.mjs',
    'dist/index.d.ts',
    'dist/client.mjs',
    'dist/client.d.ts',
    'dist/server.mjs',
    'dist/server.d.ts',
    'dist/vite.mjs',
    'dist/vite.d.ts',
    'dist/internal-ssr-renderer.mjs',
    'dist/cli.mjs',
  ]
  for (const path of required) {
    assert(files.has(path), `the npm tarball is missing ${path}.`)
  }

  for (const target of [
    manifest.main,
    manifest.module,
    manifest.types,
    ...Object.values(manifest.bin || {}),
    ...Object.values(manifest.exports || {}).flatMap((entry) =>
      Object.values(entry)
    ),
  ]) {
    assert(
      typeof target === 'string' && files.has(target.replace(/^\.\//, '')),
      `published package target ${String(target)} does not exist in the npm tarball.`
    )
  }

  const unwantedPath =
    /(^|\/)(?:src|tests?|fixtures|examples|coverage|node_modules|scripts|\.github)(?:\/|$)|(^|\/)(?:\.env(?:\.|$)|\.DS_Store$)|\.test\.[^/]+$/i
  for (const path of files) {
    assert(
      path === 'package.json' ||
        path === 'README.md' ||
        path === 'LICENSE' ||
        path.startsWith('dist/'),
      `unexpected top-level npm package content: ${path}.`
    )
    assert(!unwantedPath.test(path), `development-only content was packed: ${path}.`)
    assert(!path.endsWith('.d.ts.map'), `declaration source map was packed: ${path}.`)
    assert(
      !path.endsWith('.ts') || path.endsWith('.d.ts'),
      `TypeScript source unexpectedly became runtime package content: ${path}.`
    )
  }

  const declarations = [...files].filter((path) => path.endsWith('.d.ts'))
  const entryDeclarations = new Set([
    'dist/index.d.ts',
    'dist/client.d.ts',
    'dist/server.d.ts',
    'dist/vite.d.ts',
    'dist/internal-ssr-renderer.d.ts',
    'dist/cli.d.ts',
  ])
  for (const declaration of declarations) {
    assert(
      entryDeclarations.has(declaration),
      `internal declaration unexpectedly became package content: ${declaration}.`
    )
  }
  assert(
    declarations.length >= 4,
    'the npm tarball does not contain declarations for every public entry.'
  )
  assert(
    !record.bundled?.length,
    `the npm tarball unexpectedly bundled dependencies: ${record.bundled?.join(', ')}.`
  )
  console.log(
    `[vue-ssr-lite] package artifact: ${record.size} bytes compressed, ${record.unpackedSize} bytes unpacked, ${files.size} files`
  )
  return files
}

export const assertInstalledArtifactHygiene = async ({
  consumerRoot,
  packedFiles,
  repositoryRoot,
  assert,
}) => {
  const packageRoot = join(consumerRoot, 'node_modules/vue-ssr-lite')
  const normalizedRoot = (path) =>
    path.replaceAll('\\', '/').replace(/\/+$/, '')
  const forbiddenRoots = new Set([
    normalizedRoot(repositoryRoot),
    normalizedRoot(tmpdir()),
    normalizedRoot(await realpath(tmpdir())),
  ])
  for (const relativePath of packedFiles) {
    if (
      !relativePath.endsWith('.mjs') &&
      !relativePath.endsWith('.d.ts') &&
      !relativePath.endsWith('.map') &&
      relativePath !== 'package.json'
    ) {
      continue
    }
    const content = await readFile(join(packageRoot, relativePath), 'utf8')
    const normalized = content.replaceAll('\\', '/')
    assert(
      ![...forbiddenRoots].some((root) => normalized.includes(`${root}/`)) &&
        !/\/(?:Users|home)\/[^'"\s]+/.test(normalized) &&
        !/[A-Za-z]:\/Users\/[^'"\s]+/.test(normalized),
      `${relativePath} contains a build-machine absolute path.`
    )
    if (relativePath.endsWith('.d.ts')) {
      assert(
        !/(?:from|import\s*\()\s*['"](?:\.\.\/)+src\//.test(normalized),
        `${relativePath} references an unpublished source declaration.`
      )
    }
  }
}

export const writePublicApiChecks = async (consumerRoot) => {
  await writeFile(
    join(consumerRoot, 'package-import-smoke.mjs'),
    `import * as root from 'vue-ssr-lite'
import * as client from 'vue-ssr-lite/client'
import * as server from 'vue-ssr-lite/server'
import * as vite from 'vue-ssr-lite/vite'

const expected = [
  [root, ['defineServer', 'defineApplication', 'defineMiddleware', 'RouterView', 'LoadingIndicator', 'useSeo', 'usePublicConfig', 'useOrigin', 'useDomain', 'setHttpStatus', 'redirectTo', 'defineExtension']],
  [client, ['hydrateSsrApplication', 'mountSpaApplication']],
  [server, ['defineSitemap', 'createSsrManagedServer', 'createSsrMemoryResponseCache']],
  [vite, ['vueSsrLite']],
]
for (const [entry, names] of expected) {
  for (const name of names) {
    if (!(name in entry)) throw new Error('missing packaged export: ' + name)
  }
}
export { root, client, server, vite }
`,
    'utf8'
  )
  await writeFile(
    join(consumerRoot, 'public-api-smoke.ts'),
    `import {
  defineServer,
  defineApplication,
  defineMiddleware,
  RouterView,
  LoadingIndicator,
  useSeo,
  usePublicConfig,
  useOrigin,
  useDomain,
  setHttpStatus,
  redirectTo,
  defineExtension,
  type AppContext,
  type ApplicationConfig,
  type SiteSeoResolution,
} from 'vue-ssr-lite'
import {
  hydrateSsrApplication,
  mountSpaApplication,
  type SsrHydrateOptions,
} from 'vue-ssr-lite/client'
import {
  defineSitemap,
  createSsrManagedServer,
  createSsrMemoryResponseCache,
  type SitemapContext,
} from 'vue-ssr-lite/server'
import { vueSsrLite, type SsrVitePluginOptions } from 'vue-ssr-lite/vite'

void [
  defineServer,
  defineApplication,
  defineMiddleware,
  RouterView,
  LoadingIndicator,
  useSeo,
  usePublicConfig,
  useOrigin,
  useDomain,
  setHttpStatus,
  redirectTo,
  defineExtension,
  hydrateSsrApplication,
  mountSpaApplication,
  defineSitemap,
  createSsrManagedServer,
  createSsrMemoryResponseCache,
  vueSsrLite,
]
type PublicTypes = [
  AppContext,
  ApplicationConfig,
  SiteSeoResolution,
  SsrHydrateOptions,
  SitemapContext,
  SsrVitePluginOptions,
]
export type { PublicTypes }
`,
    'utf8'
  )
  await writeFile(
    join(consumerRoot, 'tsconfig.release-smoke.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ['node'],
        },
        files: ['public-api-smoke.ts'],
      },
      null,
      2
    ),
    'utf8'
  )
}

export const assertPublicApiChecks = async (consumerRoot) => {
  await execFile(process.execPath, [join(consumerRoot, 'package-import-smoke.mjs')], {
    cwd: consumerRoot,
  })
  await execFile(
    process.execPath,
    [
      join(consumerRoot, 'node_modules/typescript/bin/tsc'),
      '--project',
      join(consumerRoot, 'tsconfig.release-smoke.json'),
    ],
    { cwd: consumerRoot }
  )
}
