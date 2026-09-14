import { defineApplication } from '../../../../../../src/index'
import routes from './routes'

export default defineApplication({
  name: 'admin',
  render: 'spa',
  domain: {
    development: 'admin.localhost',
    production: 'admin.test',
    mode: 'root',
  },
  routes,
  seo: {
    site: {
      title: 'Admin',
      siteName: 'Admin',
      description: 'ADMIN_STATIC_SEO_DEFAULT',
      index: false,
      follow: false,
    },
  },
})
