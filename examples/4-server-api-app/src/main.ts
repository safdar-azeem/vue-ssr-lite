import type { AppContext } from 'vue-ssr-lite'
import routes from './routes'
import './style.css'

export { routes }

export default (_context: AppContext) => {
  // Install ordinary Vue plugins here.
}
