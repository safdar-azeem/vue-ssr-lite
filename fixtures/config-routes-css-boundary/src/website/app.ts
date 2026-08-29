import { defineApplication } from '../../../src/index'
import routes from './routes'

export default defineApplication({
  name: 'website',
  render: 'ssr',
  host: ['website.localhost', 'website.test'],
  routes,
})
