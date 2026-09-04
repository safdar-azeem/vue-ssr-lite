<script setup lang="ts">
interface ProductFixtureGlobal {
  __VSSL_WAIT_FOR_PRODUCTS__?: () => Promise<void>
}

await (globalThis as typeof globalThis & ProductFixtureGlobal)
  .__VSSL_WAIT_FOR_PRODUCTS__?.()

const response = await fetch(
  'data:application/json,%7B%22title%22%3A%22Fixture%20Product%22%7D'
)
const product = (await response.json()) as { title: string }
</script>

<template>
  <section class="products-page">
    <h1>Products page</h1>
    <p id="details">{{ product.title }}</p>
  </section>
</template>
