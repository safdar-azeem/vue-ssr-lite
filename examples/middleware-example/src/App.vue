<template>
  <div class="app-shell">
    <header class="app-header">
      <div>
        <p class="eyebrow">vue-ssr-lite</p>
        <h1>Middleware Example</h1>
      </div>

      <nav>
        <RouterLink to="/">Home</RouterLink>
        <RouterLink to="/about">About</RouterLink>
        <RouterLink to="/dashboard">Dashboard</RouterLink>
      </nav>
    </header>

    <main>
      <RouterView />
    </main>
  </div>
</template>
