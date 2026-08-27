import { defineApplication } from '../../../../src/index'
import routes from './routes'

export default defineApplication({
  name: 'website',
  render: 'ssr',
  host: ['website.localhost', 'website.test'],
  domain: {
    development: 'website.localhost',
    production: 'website.test',
  },
  template: './website.html',
  routes,
  app: {
    main: './main.ts',
    root: './WebsiteShell.vue',
  },
})
