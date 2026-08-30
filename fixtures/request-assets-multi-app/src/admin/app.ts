import { defineApplication } from '../../../../src/index'
import routes from './routes'

export default defineApplication({
  name: 'admin',
  render: 'ssr',
  domain: {
    development: 'admin.localhost',
    production: 'admin.test',
    mode: 'root',
  },
  template: './admin.html',
  routes,
  app: {
    main: './main.ts',
    root: './AdminShell.vue',
  },
})
