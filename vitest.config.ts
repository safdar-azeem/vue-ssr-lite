import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const typescriptResolve = fileURLToPath(
  new URL('./scripts/SsrRegisterTypeScriptResolve.mjs', import.meta.url)
)
const execArgv = ['--import', typescriptResolve]

const sharedResolve = {
  // Repository examples exercise the current public helpers before a package build.
  alias: [{ find: /^vue-ssr-lite$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) }],
  // The package renders with the Vue framework only. It is API-client
  // neutral, so no GraphQL/Apollo packages are aliased or deduplicated here.
  dedupe: ['@vue/server-renderer', 'vue', 'vue-router'],
}

export default defineConfig({
  resolve: sharedResolve,
  test: {
    execArgv,
    projects: [
      {
        resolve: sharedResolve,
        test: {
          name: 'admin-spa',
          execArgv,
          include: ['src/fixtures/SsrArchitectureAdminSpa.test.ts'],
          environment: './SsrTestJsdomEnvironment.ts',
          environmentOptions: {
            jsdom: { url: 'http://admin.localhost/' },
          },
        },
      },
      {
        resolve: sharedResolve,
        test: {
          name: 'unit',
          execArgv,
          include: ['src/**/*.test.ts'],
          exclude: ['src/fixtures/SsrArchitectureAdminSpa.test.ts'],
        },
      },
    ],
  },
})
