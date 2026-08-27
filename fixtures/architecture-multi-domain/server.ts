import { defineServer } from '../../src/index'
import website from './src/modules/website/app'
import admin from './src/modules/admin/app'
import docs from './src/modules/docs/app'

export default defineServer({
  server: { port: 0, trustProxy: true },
  applications: [website, admin, docs],
})
