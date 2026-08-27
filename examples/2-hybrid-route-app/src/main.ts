import { createPinia } from 'pinia'
import routes from './routes'
import './style.css'

export { routes }

export default ({ app }: { app: any }) => {
  app.use(createPinia())
}
