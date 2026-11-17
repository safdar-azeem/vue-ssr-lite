<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useFetch } from 'vue-ssr-lite'

const route = useRoute()
const id = computed(() => String(route.query.id ?? 'none'))
const { data } = useFetch<{ id: string }>(() => `/api/isolation?id=${encodeURIComponent(id.value)}`)
</script>

<template>
  <p id="isolation">query={{ id }} fetched={{ data?.id }}</p>
</template>
