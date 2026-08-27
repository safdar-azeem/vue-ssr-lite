import { createPinia } from 'pinia'
import './style.css'

export default ({ app }: { app: any }) => {
  app.use(createPinia())
}
