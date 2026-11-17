import { defineServer } from 'vue-ssr-lite'
import { serverMiddleware } from './server/middleware'
import { serverRoutes } from './server/routes'

export default defineServer({
  render: 'ssr',

  seo: {
    site: {
      title: 'Workers Demo',
      siteName: 'vue-ssr-lite Workers Demo',
      description: 'vue-ssr-lite rendered on Cloudflare Workers.',
      index: true,
      follow: true,
    },
    sitemap: async () => [
      { loc: '/' },
      { loc: '/posts/hello-workers' },
      { loc: '/posts/hybrid-routing' },
    ],
    robots: {
      groups: [{ userAgents: ['*'], allow: ['/'], disallow: ['/dashboard', '/api'] }],
    },
  },

  serverMiddleware,
  serverRoutes,
})
