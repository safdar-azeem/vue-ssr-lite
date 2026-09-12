import { defineComponent, h, ref } from 'vue'
import { useFetch, useSeo } from 'vue-ssr-lite'
import { ssrWatch, ssrWatchEffect } from 'vue-ssr-lite/client'
import './page.css'
export default defineComponent({
  setup() {
    const count = ref(0)
    const result = useFetch<{ message: string }>('/api/capability')
    useSeo(() => ({ title: `Full ${count.value}` }))
    ssrWatch(count, () => {})
    ssrWatchEffect(() => { void count.value })
    return () => h('main', { onClick: () => count.value++ }, result.data.value?.message ?? `${count.value}`)
  },
})
