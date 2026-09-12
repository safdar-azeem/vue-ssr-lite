import { createApp, defineComponent, h, ref, watch, watchEffect } from 'vue'

createApp(defineComponent({
  setup() {
    const count = ref(1)
    const doubled = ref(0)
    const label = ref('')
    watch(count, value => { doubled.value = value * 2 }, { immediate: true, flush: 'sync' })
    watchEffect(() => { label.value = `watcher-count:${count.value}` }, { flush: 'sync' })
    return () => h('button', { onClick: () => count.value++ }, `${label.value} / ${doubled.value}`)
  },
})).mount('#app')
