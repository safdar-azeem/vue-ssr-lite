import type { AppContext } from 'vue-ssr-lite'
import { routes } from './routes'

export { routes }

export default (_context: AppContext) => {
  // RouterLink and RouterView intentionally rely on app.use(router)'s normal
  // global registration. This fixture must exercise template resolution.
}
