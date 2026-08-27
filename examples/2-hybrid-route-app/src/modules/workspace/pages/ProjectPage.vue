<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useSeo } from 'vue-ssr-lite'

const route = useRoute()

useSeo(computed(() => ({
  title: `Project ${String(route.params.id)}`,
  description: 'Dynamic SEO metadata inside the SPA route tree.',
  index: false,
  follow: false,
})))
</script>

<template>
  <section>
    <h1>Project {{ route.params.id }}</h1>
  </section>
</template>
