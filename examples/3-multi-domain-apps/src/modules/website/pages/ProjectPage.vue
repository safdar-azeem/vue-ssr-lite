<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useSeo } from 'vue-ssr-lite'

const route = useRoute()

useSeo(computed(() => ({
  title: `Project: ${String(route.params.slug)}`,
  description: `Dynamic project SEO for ${String(route.params.slug)}.`,
})))
</script>

<template>
  <article>
    <h1>Project: {{ route.params.slug }}</h1>
  </article>
</template>
