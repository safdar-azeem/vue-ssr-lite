/** Marker used only for temporary development stylesheets owned by vue-ssr-lite. */
export const SSR_DEVELOPMENT_STYLESHEET_ATTRIBUTE =
  'data-vue-ssr-lite-style'

/** Marker for request-specific development CSS retained until Vite owns it. */
export const SSR_DEVELOPMENT_RENDERED_STYLESHEET_ATTRIBUTE =
  'data-vue-ssr-lite-rendered-style'

/** A browser stylesheet owned by one configured application. */
export interface SsrApplicationStylesheet {
  applicationId: string
  href: string
}

/** Framework-neutral link asset resolved for the final SSR render. */
export interface SsrRenderedApplicationAsset {
  applicationId: string
  href: string
  rel: 'stylesheet' | 'modulepreload'
  /** Development request CSS is temporary until Vite's CSS module is active. */
  temporary?: boolean
}

/**
 * Give Vite's development CSS runtime ownership of each server-rendered style
 * before removing its corresponding temporary link. CSS modules are activated
 * directly, so this remains correct for nested async components and delayed
 * Vue hydration without forcing their component JavaScript to execute.
 */
export const activateSsrDevelopmentRenderedStylesheets = async (
  applicationId: string,
  document: Document,
  loadStylesheet: (href: string) => Promise<unknown> = (href) =>
    import(/* @vite-ignore */ href)
): Promise<void> => {
  const stylesheets = [...document.querySelectorAll(
    `link[${SSR_DEVELOPMENT_RENDERED_STYLESHEET_ATTRIBUTE}]`
  )].filter(
    (stylesheet) =>
      stylesheet.getAttribute(
        SSR_DEVELOPMENT_RENDERED_STYLESHEET_ATTRIBUTE
      ) === applicationId
  )
  await Promise.all(
    stylesheets.map(async (stylesheet) => {
      const href = stylesheet.getAttribute('href')
      if (!href) return
      try {
        await loadStylesheet(href)
        // A successful Vite CSS module evaluation is the ownership boundary.
        // Keep the temporary link when activation fails so styling never gaps.
        if (stylesheet.isConnected) {
          stylesheet.remove()
        }
      } catch (error) {
        console.warn(
          '[vue-ssr-lite] rendered stylesheet activation failed; retaining SSR stylesheet',
          error
        )
      }
    })
  )
}

/** Emit the per-resource Vite CSS ownership handoff for generated clients. */
export const generateSsrDevelopmentRenderedStylesheetHandoff = (
  applicationId: string
): string[] => [
  `const __vueSsrLiteRenderedStyles = [...document.querySelectorAll('link[${SSR_DEVELOPMENT_RENDERED_STYLESHEET_ATTRIBUTE}]')].filter((stylesheet) => stylesheet.getAttribute(${JSON.stringify(SSR_DEVELOPMENT_RENDERED_STYLESHEET_ATTRIBUTE)}) === ${JSON.stringify(applicationId)})`,
  'await Promise.all(__vueSsrLiteRenderedStyles.map(async (stylesheet) => {',
  "  const href = stylesheet.getAttribute('href')",
  '  if (!href) return',
  '  try {',
  '    await import(/* @vite-ignore */ href)',
  '    if (stylesheet.isConnected) stylesheet.remove()',
  '  } catch (error) {',
  "    console.warn('[vue-ssr-lite] rendered stylesheet activation failed; retaining SSR stylesheet', error)",
  '  }',
  '}))',
]

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
