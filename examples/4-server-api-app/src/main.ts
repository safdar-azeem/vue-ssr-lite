import { setContext, type AppContext } from 'vue-ssr-lite'
import { memberHeaders } from './demoAuth'
import routes from './routes'
import './style.css'

export { routes }

export default (_context: AppContext) => {
  setContext({ headers: memberHeaders })
}
