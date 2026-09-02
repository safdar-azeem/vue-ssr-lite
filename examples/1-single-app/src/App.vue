<template>
  <div class="shell">
    <nav>
      <RouterLink to="/">Home</RouterLink>
      <RouterLink to="/about">About</RouterLink>
      <RouterLink to="/posts/hello-world">Dynamic Post</RouterLink>
      <RouterLink to="/products">Products</RouterLink>
    </nav>

    <RouterView v-slot="{ Component }">
      <Suspense>
        <component :is="Component" />

        <template #fallback>
          <p>Loading page…</p>
        </template>
      </Suspense>
    </RouterView>
  </div>
</template>
