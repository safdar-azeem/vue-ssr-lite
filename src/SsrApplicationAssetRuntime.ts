/** Marker used only for temporary development stylesheets owned by vue-ssr-lite. */
export const SSR_DEVELOPMENT_STYLESHEET_ATTRIBUTE =
  'data-vue-ssr-lite-style'

/** A browser stylesheet owned by one configured application. */
export interface SsrApplicationStylesheet {
  applicationId: string
  href: string
}

/**
 * Emit the browser-side ownership handoff for a generated SSR client entry.
 *
 * Static imports have finished evaluating before these statements run, so
 * Vite's development CSS runtime is already active. Only links carrying this
 * application's framework marker are removed; consumer-owned resources are
 * never selected.
 */
export const generateSsrDevelopmentStylesheetHandoff = (
  applicationId: string
): string[] => [
  `for (const stylesheet of document.querySelectorAll('link[${SSR_DEVELOPMENT_STYLESHEET_ATTRIBUTE}]')) {`,
  `  if (stylesheet.getAttribute(${JSON.stringify(SSR_DEVELOPMENT_STYLESHEET_ATTRIBUTE)}) === ${JSON.stringify(applicationId)}) {`,
  '    stylesheet.remove()',
  '  }',
  '}',
]
