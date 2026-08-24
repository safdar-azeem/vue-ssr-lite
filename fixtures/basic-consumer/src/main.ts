import { defineComponent, h } from 'vue'
import { defineApplication } from '../../../src/index'

const App = defineComponent({
  name: 'BasicConsumerApp',
  setup() {
    return () => h('div', 'basic-consumer')
  },
})

export default defineApplication({
  root: App,
  routes: [{ path: '/', component: App }],
})
