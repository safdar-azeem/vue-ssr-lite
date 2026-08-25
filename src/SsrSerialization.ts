import { escapeSsrHtml, serializeSsrState } from './SsrEscape'

export { escapeSsrHtml, serializeSsrState }

export const sanitizeSsrIdentifier = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app'

export const getSsrStateElementId = (applicationId: string): string =>
  `vue-ssr-lite-state-${sanitizeSsrIdentifier(applicationId)}`
