import { defineComponent, h } from 'vue'
import { defineApplication, usePublicConfig, useSeo } from '../../../src/index'
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

const App = defineComponent({
  name: 'AdvancedApp',
  setup() {
    return () => h(Home)
  },
})

export default defineApplication({
  root: App,
  routes: [{ path: '/', component: Home }],
  seo: {
    siteName: 'Advanced',
    titleTemplate: '%s | Advanced',
  },
  extensions: [analyticsExtension({ propertyId: 'UA-123456' })],
})
