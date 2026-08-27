<template>
  <section>
    <nav>
      <RouterLink to="/admin">Dashboard</RouterLink>
      <RouterLink to="/admin/users">Users</RouterLink>
      <RouterLink to="/admin/settings">Settings</RouterLink>
      <a href="/">Public Site</a>
    </nav>

    <RouterView />
  </section>
</template>
