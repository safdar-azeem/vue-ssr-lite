import { defineComponent, h } from 'vue'
import { defineSsrApplication } from '../../../src/index'

const Root = defineComponent({
  name: 'CleanConsumerRoot',
  setup() {
    return () => h('div', 'clean-consumer')
  },
})

export const appApplication = defineSsrApplication({
  id: 'app',
  rootComponent: Root,
  routes: [{ path: '/', component: Root }],
})
