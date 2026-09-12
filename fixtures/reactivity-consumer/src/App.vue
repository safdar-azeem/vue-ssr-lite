<script setup lang="ts">
import { ref } from 'vue'
import { ssrWatch, ssrWatchEffect } from 'vue-ssr-lite/client'

const count = ref(1)
const doubled = ref(0)
const label = ref('')
ssrWatch(count, value => { doubled.value = value * 2 }, { immediate: true })
ssrWatchEffect(() => { label.value = `watcher-count:${count.value}` })
</script>

<template>
  <button @click="count++">{{ label }} / {{ doubled }}</button>
</template>

<style scoped>button { color: navy }</style>
