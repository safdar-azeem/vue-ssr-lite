<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useSeo } from 'vue-ssr-lite'

const route = useRoute()

const post = computed(() => ({
  title: `Post: ${String(route.params.slug)}`,
  description: `Dynamic SEO for ${String(route.params.slug)}.`,
}))

useSeo(computed(() => ({
  title: post.value.title,
  description: post.value.description,
  openGraph: {
    title: post.value.title,
    description: post.value.description,
  },
})))
</script>

<template>
  <article>
    <h1>{{ post.title }}</h1>
    <p>{{ post.description }}</p>
  </article>
</template>
