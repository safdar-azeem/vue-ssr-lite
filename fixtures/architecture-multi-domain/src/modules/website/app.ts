import { defineApplication } from '../../../../../src/index'
import routes from './routes'

export default defineApplication({
  name: 'website',
  render: 'ssr',
  domain: {
    development: 'website.localhost',
    production: 'website.test',
    mode: 'root',
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
