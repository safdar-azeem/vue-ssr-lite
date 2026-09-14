<script setup lang="ts">
import { ref } from 'vue'

const note = ref('preserved')
</script>

<template>
  <article class="about-page">
    About page
    <input v-model="note" class="about-note" />
  </article>
</template>
