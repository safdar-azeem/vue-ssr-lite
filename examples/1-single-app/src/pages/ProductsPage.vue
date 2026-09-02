<script setup lang="ts">
interface Product {
  id: number
  title: string
  description: string
  price: number
  thumbnail: string
}

interface ProductsResponse {
  products: Product[]
}

let products: Product[] = []
let errorMessage = ''

try {
  const response = await fetch(
    'https://dummyjson.com/products?limit=6&select=id,title,description,price,thumbnail',
  )

  if (!response.ok) {
    throw new Error(`Products request failed with status ${response.status}`)
  }

  const data = (await response.json()) as ProductsResponse
  products = data.products
} catch {
  errorMessage = 'Unable to load products right now.'
}
</script>

<template>
  <section>
    <h1>Products</h1>
    <p>Fetched from DummyJSON with native <code>fetch()</code>.</p>

    <p v-if="errorMessage">{{ errorMessage }}</p>

    <div v-else class="products-grid">
      <article v-for="product in products" :key="product.id" class="product-card">
        <img :src="product.thumbnail" :alt="product.title" width="160" height="160">
        <div>
          <h2>{{ product.title }}</h2>
          <p class="product-description">{{ product.description }}</p>
          <p><strong>${{ product.price.toFixed(2) }}</strong></p>
        </div>
      </article>
    </div>
  </section>
</template>
