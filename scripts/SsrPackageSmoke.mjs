import { readFile } from 'node:fs/promises'

const [runtime, client, server, vite] = await Promise.all([
  import('../dist/index.mjs'),
  import('../dist/client.mjs'),
  import('../dist/server.mjs'),
  import('../dist/vite.mjs'),
])

const expectedExports = [
  [runtime, 'defineSsrConfig'],
  [runtime, 'defineSsrApplication'],
  [runtime, 'useSsrDomain'],
  [client, 'hydrateSsrApplication'],
  [client, 'mountSpaApplication'],
  [server, 'createSsrManagedServer'],
  [server, 'compileSsrConfig'],
  [vite, 'vueSsrLite'],
]

for (const [entry, exportName] of expectedExports) {
  if (typeof entry[exportName] !== 'function') {
    throw new Error(`The ESM package entry does not export ${exportName}().`)
  }
}

const cliSource = await readFile(new URL('../dist/cli.mjs', import.meta.url), 'utf8')
if (!cliSource.startsWith('#!/usr/bin/env node')) {
  throw new Error('The CLI package entry is missing its Node.js shebang.')
}

console.log('[vue-ssr-lite] ESM package entries passed')
