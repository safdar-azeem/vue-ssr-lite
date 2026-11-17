<script setup lang="ts">
import { ref } from 'vue'
import { useFetch } from 'vue-ssr-lite'

const count = ref(0)
const hydrated = ref(false)
const { data } = useFetch<{ message: string; runtime: string; greeting: string | null }>('/api/hello')

if (typeof window !== 'undefined') {
  // Runs only in the browser after hydration takes over this component.
  queueMicrotask(() => { hydrated.value = true })
}
</script>

<template>
  <section>
    <h1 id="home-title">Vue SSR on Cloudflare Workers</h1>
    <p id="server-message">{{ data?.message }} ({{ data?.runtime }})</p>
    <p id="greeting">Greeting binding: {{ data?.greeting ?? 'none' }}</p>
    <button id="counter" type="button" @click="count++">Clicked {{ count }} times</button>
    <p id="hydration-state">{{ hydrated ? 'hydrated' : 'server-rendered' }}</p>
  </section>
</template>
