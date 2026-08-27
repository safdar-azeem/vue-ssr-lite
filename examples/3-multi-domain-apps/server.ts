import { defineServer } from 'vue-ssr-lite'

import website from './src/modules/website/app'
import admin from './src/modules/admin/app'
import docs from './src/modules/docs/app'

export default defineServer({
  server: {
    port: 4213,
    trustProxy: true,
  },

  applications: [website, admin, docs],

  // Global app config omitted intentionally.
  // Defaults:
  //   main -> /src/main.ts
  //   root -> /src/App.vue
})
