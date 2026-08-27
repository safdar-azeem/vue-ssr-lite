import { defineApplication } from '../../../../../src/index'
import routes from './routes'

export default defineApplication({
  name: 'admin',
  render: 'spa',
  host: ['admin.localhost', 'admin.test'],
  domain: {
    development: 'admin.localhost',
    production: 'admin.test',
  },
  routes,
  seo: {
    site: {
      title: 'Admin',
      siteName: 'Admin',
      description: 'ADMIN_SERVER_ONLY_PROVIDER',
      index: false,
      follow: false,
    },
  },
})
