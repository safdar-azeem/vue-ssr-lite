import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // The package renders with the Vue framework only. It is API-client
    // neutral, so no GraphQL/Apollo packages are aliased or deduplicated here.
    dedupe: ['@vue/server-renderer', 'vue', 'vue-router'],
  },
})
