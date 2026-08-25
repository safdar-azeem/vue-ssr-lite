<script setup lang="ts">
import { defineAsyncComponent, hydrateOnVisible } from 'vue'

const AsyncCard = defineAsyncComponent({
  loader: () => import('./AsyncCard.vue'),
  hydrate: hydrateOnVisible(),
})
</script>

<template>
  <section class="lazy-page">lazy-consumer<AsyncCard /></section>
</template>

<style scoped>
.lazy-page { border: 2px solid rgb(7 8 9); }
</style>
