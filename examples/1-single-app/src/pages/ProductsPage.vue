<script setup lang="ts">
import { ref } from 'vue'
import { useFetch } from 'vue-ssr-lite'
import type { ProductsResponse } from '../types/products'

const { data, pending, error, refresh } = useFetch<ProductsResponse>('/api/products', {
  fetchPolicy: 'cache-first',
})
</script>

<template>
  <section>
    <h1>Products</h1>
    <p>Our example catalog, fetched with SSR-aware <code>useFetch()</code>.</p>
    <button type="button" :disabled="pending" @click="refresh()">Refresh products</button>

    <p v-if="pending" role="status">Loading products…</p>
    <p v-if="error" role="alert">
      Unable to load products right now.<span v-if="error.status"> (HTTP {{ error.status }})</span>
    </p>

    <div v-if="data" class="products-grid" :aria-busy="pending">
      <article v-for="product in data.products" :key="product.id" class="product-card">
        <div class="product-mark" aria-hidden="true">{{ product.title.charAt(0) }}</div>
        <div>
          <h2>{{ product.title }}</h2>
          <p class="product-description">{{ product.description }}</p>
          <p>
            <strong>${{ product.price.toFixed(2) }}</strong>
          </p>
        </div>
      </article>
    </div>
  </section>
</template>
