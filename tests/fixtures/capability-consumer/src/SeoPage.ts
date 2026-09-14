import { defineComponent, h, ref } from 'vue'
import { useSeo } from 'vue-ssr-lite'
import './page.css'
export default defineComponent({
  setup() {
    const title = ref('Capability SEO')
    useSeo(() => ({ title: title.value }))
    return () => h('main', title.value)
  },
})
