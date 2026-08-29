import { defineServer } from '../../src/index'
import website from './src/website/app'
import admin from './src/admin/app'

export default defineServer({
  server: { port: 0 },
  applications: [website, admin],
})
