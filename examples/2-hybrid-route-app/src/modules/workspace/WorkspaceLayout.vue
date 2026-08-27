<template>
  <section>
    <nav>
      <RouterLink to="/app">Workspace</RouterLink>
      <RouterLink to="/app/projects">Projects</RouterLink>
      <RouterLink to="/app/settings">Settings</RouterLink>
      <a href="/">Public Site</a>
    </nav>

    <RouterView />
  </section>
</template>
