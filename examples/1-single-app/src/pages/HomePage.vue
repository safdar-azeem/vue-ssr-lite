<script setup lang="ts">
import { useCounterStore } from '../stores/counter'

const counter = useCounterStore()
</script>

<template>
  <section>
    <h1>Home</h1>
    <p>Pinia count: {{ counter.count }}</p>
    <button @click="counter.increment()">Increment</button>
  </section>
</template>
