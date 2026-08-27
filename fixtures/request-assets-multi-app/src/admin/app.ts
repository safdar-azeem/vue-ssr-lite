import { defineApplication } from '../../../../src/index'
import routes from './routes'

export default defineApplication({
  name: 'admin',
  render: 'ssr',
  host: ['admin.localhost', 'admin.test'],
  domain: {
    development: 'admin.localhost',
    production: 'admin.test',
  },
  template: './admin.html',
  routes,
  app: {
    main: './main.ts',
    root: './AdminShell.vue',
  },
})
