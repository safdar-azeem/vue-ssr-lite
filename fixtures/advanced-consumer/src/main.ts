import { defineComponent, h } from 'vue'
import type { AppContext } from '../../../src/index'
import { usePublicConfig, useSeo } from '../../../src/index'
import { analyticsExtension } from './extensions/custom-analytics'

const Home = defineComponent({
  name: 'AdvancedHome',
  setup() {
    const config = usePublicConfig<{ feature: string }>()
    useSeo({
      title: 'Advanced',
      description: config.feature,
    })
    return () => h('main', config.feature)
  },
})

const routes = [{ path: '/', component: Home }]

export { routes }

export default (_context: AppContext) => {
  // Custom extensions are registered through server.ts.
}

export { analyticsExtension }
