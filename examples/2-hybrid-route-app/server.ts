import { defineServer } from 'vue-ssr-lite'
import { siteSeo } from './src/seo/site'
import { sitemap } from './src/seo/sitemap'
import { robots } from './src/seo/robots'

export default defineServer({
  // Default for the whole single application.
  render: 'ssr',

  server: {
    port: 4212,
    trustProxy: true,
  },

  seo: {
    site: siteSeo,
    sitemap,
    robots,
  },
})
