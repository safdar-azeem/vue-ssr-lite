import { createPinia } from 'pinia'
import type { AppContext } from 'vue-ssr-lite'
import './style.css'

export default ({ app }: AppContext) => {
  app.use(createPinia())
}
