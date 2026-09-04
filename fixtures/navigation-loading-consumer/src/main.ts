import type { AppContext } from 'vue-ssr-lite'
import { routes } from './routes'

export { routes }

export default (_context: AppContext) => {
  // RouterLink intentionally relies on app.use(router)'s normal global
  // registration. App.vue imports the enhanced route outlet explicitly.
}
