import { defineComponent, h } from 'vue'
import { defineApplication } from '../../../src/index'

const Root = defineComponent({
  name: 'CleanConsumerRoot',
  setup() {
    return () => h('div', 'clean-consumer')
  },
})

export default defineApplication({
  root: Root,
  routes: [{ path: '/', component: Root }],
})
