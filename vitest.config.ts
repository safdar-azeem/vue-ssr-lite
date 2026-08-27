import { defineConfig } from 'vitest/config'

const sharedResolve = {
  // The package renders with the Vue framework only. It is API-client
  // neutral, so no GraphQL/Apollo packages are aliased or deduplicated here.
  dedupe: ['@vue/server-renderer', 'vue', 'vue-router'],
}

export default defineConfig({
  resolve: sharedResolve,
  test: {
    projects: [
      {
        resolve: sharedResolve,
        test: {
          name: 'admin-spa',
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
          include: ['src/**/*.test.ts'],
          exclude: ['src/fixtures/SsrArchitectureAdminSpa.test.ts'],
        },
      },
    ],
  },
})
