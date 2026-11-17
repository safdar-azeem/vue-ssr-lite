<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useFetch, useSeo } from 'vue-ssr-lite'

const route = useRoute()
const slug = computed(() => String(route.params.slug))
const { data, error } = useFetch<{ slug: string; title: string; body: string }>(() => `/api/posts/${slug.value}`)

// Only a confirmed HTTP 404 from the API means the post does not exist.
// Any other failure (network, timeout, 5xx, parse) is a service error.
const missing = computed(() => error.value?.kind === 'http' && error.value.status === 404)
const failed = computed(() => !!error.value && !missing.value)

useSeo(() => ({
  status: missing.value ? 404 : failed.value ? 503 : undefined,
  title: data.value?.title ?? (missing.value ? 'Post not found' : failed.value ? 'Post unavailable' : 'Post'),
  description: data.value?.body,
}))
</script>

<template>
  <article>
    <h1 id="post-title">{{ data?.title ?? (missing ? 'Post not found' : failed ? 'Post unavailable' : '') }}</h1>
    <p id="post-body">
      {{ data?.body ?? (missing ? 'This post does not exist.' : failed ? 'The post could not be loaded. Please try again.' : '') }}
    </p>
    <p id="post-slug">slug: {{ slug }}</p>
  </article>
</template>
