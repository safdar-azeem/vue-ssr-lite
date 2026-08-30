import { defineApplication } from '../../../../src/index'
import routes from './routes'

export default defineApplication({
  name: 'website',
  render: 'ssr',
  domain: {
    development: 'website.localhost',
    production: 'website.test',
    mode: 'root',
  },
  template: './website.html',
  routes,
  app: {
    main: './main.ts',
    root: './WebsiteShell.vue',
  },
})
