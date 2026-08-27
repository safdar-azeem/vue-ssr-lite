<template>
  <div class="shell">
    <nav>
      <RouterLink to="/">Home</RouterLink>
      <RouterLink to="/about">About</RouterLink>
      <RouterLink to="/posts/hello-world">Dynamic Post</RouterLink>
    </nav>

    <RouterView />
  </div>
</template>
