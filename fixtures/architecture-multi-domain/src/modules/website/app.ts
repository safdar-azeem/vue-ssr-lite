import { defineApplication } from '../../../../../src/index'
import routes from './routes'

export default defineApplication({
  name: 'website',
  render: 'ssr',
  host: ['website.localhost', 'website.test'],
  domain: {
    development: 'website.localhost',
    production: 'website.test',
  },
  routes,
  seo: {
    site: {
      title: 'Website',
      siteName: 'Website',
      description: 'WEBSITE_SERVER_ONLY_PROVIDER',
    },
  },
})
