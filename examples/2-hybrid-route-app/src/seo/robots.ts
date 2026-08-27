export const robots = {
  resolve: async (context: { siteOrigin: string }) => ({
    status: 'resolved' as const,
    config: {
      groups: [
        {
          userAgents: ['*'],
          allow: ['/'],
          disallow: ['/app', '/admin'],
        },
      ],
      sitemaps: [`${context.siteOrigin}/sitemap.xml`],
    },
  }),
}
