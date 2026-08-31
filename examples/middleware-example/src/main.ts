import type { AppContext } from 'vue-ssr-lite'
import routes from './router'
import './style.css'

export { routes }

export default (_context: AppContext) => {
  // Install ordinary Vue plugins here, exactly as before.
}
