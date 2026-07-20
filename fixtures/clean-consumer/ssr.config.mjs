export default {
  name: 'clean-consumer',
  runtime: process.env.APP_RUNTIME,
  applications: {
    app: {
      render: 'spa',
      application: {
        module: './src/AppApplication.ts',
        exportName: 'appApplication',
      },
      template: 'index.html',
      domain: {
        development: 'localhost',
        production: 'app.example.com',
        mode: 'root',
        localAliases: true,
      },
      publicConfig: {
        greeting: 'hello',
      },
    },
  },
}
