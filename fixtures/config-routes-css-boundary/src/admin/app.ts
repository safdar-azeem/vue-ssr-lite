import { defineApplication } from '../../../src/index'
import { routes } from './routes'

export default defineApplication({
  name: 'admin',
  render: 'spa',
  host: ['admin.localhost', 'admin.test'],
  routes,
})
