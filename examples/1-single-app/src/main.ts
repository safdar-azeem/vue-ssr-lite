import { createPinia } from 'pinia'
import routes from './routes'
import './style.css'

export { routes }

export default ({ app }: { app: any }) => {
  // Fresh Pinia instance per SSR app/request.
  app.use(createPinia())
}
