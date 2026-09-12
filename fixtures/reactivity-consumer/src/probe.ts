import { createApp, defineComponent, h, ref } from 'vue'
import { ssrWatch, ssrWatchEffect } from 'vue-ssr-lite/client'

createApp(defineComponent({
  setup() {
    const count = ref(1)
    const doubled = ref(0)
    const label = ref('')
    ssrWatch(count, value => { doubled.value = value * 2 }, { immediate: true })
    ssrWatchEffect(() => { label.value = `watcher-count:${count.value}` })
    return () => h('button', { onClick: () => count.value++ }, `${label.value} / ${doubled.value}`)
  },
})).mount('#app')
