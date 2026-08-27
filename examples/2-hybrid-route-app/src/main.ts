import { createPinia } from 'pinia'
import type { AppContext } from 'vue-ssr-lite'
import routes from './routes'
import './style.css'

export { routes }

export default ({ app }: AppContext) => {
  app.use(createPinia())
}
