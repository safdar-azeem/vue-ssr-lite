import { defineServer } from '../../src/index'
import { siteSeo } from './src/seo/site'

export default defineServer({
  render: 'ssr',
  server: { port: 0 },
  seo: { site: siteSeo },
})
