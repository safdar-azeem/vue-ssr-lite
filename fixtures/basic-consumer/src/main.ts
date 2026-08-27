import type { AppContext } from '../../../src/index'
import { defineComponent, h } from 'vue'

const App = defineComponent({
  name: 'BasicConsumerApp',
  setup() {
    return () => h('div', 'basic-consumer')
  },
})

const routes = [{ path: '/', component: App }]

export { routes }

export default ({ app }: AppContext) => {
  void app
}
