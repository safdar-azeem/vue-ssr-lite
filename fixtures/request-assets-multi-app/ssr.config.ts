export default {
  server: { port: 0 },
  applications: {
    website: {
      render: 'ssr',
      host: ['website.localhost', 'website.test'],
      application: { module: './src/website/main.ts' },
      template: './website.html',
      domain: {
        development: 'website.localhost',
        production: 'website.test',
      },
    },
    admin: {
      render: 'ssr',
      host: ['admin.localhost', 'admin.test'],
      application: { module: './src/admin/main.ts' },
      template: './admin.html',
      domain: {
        development: 'admin.localhost',
        production: 'admin.test',
      },
    },
  },
}
