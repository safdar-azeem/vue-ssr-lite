import { defineComponent, h } from 'vue'
import { useFetch } from 'vue-ssr-lite'
import './page.css'
export default defineComponent({
  setup() {
    const result = useFetch<{ message: string }>('/api/capability')
    return () => h('main', result.data.value?.message ?? 'pending')
  },
})
