import { defineServerMiddleware } from 'vue-ssr-lite'

/** Global middleware: wraps pages, APIs and static assets alike. */
const demoHeader = defineServerMiddleware(async (_request, _context, next) => {
  const response = await next()
  response.headers.set('x-demo-middleware', 'global')
  return response
})

/** Redirect handled before routing. */
const legacyRedirect = defineServerMiddleware(async (request, _context, next) => {
  const url = new URL(request.url)
  if (url.pathname === '/old-home') return Response.redirect(new URL('/', url), 301)
  return next()
})

export const serverMiddleware = [demoHeader, legacyRedirect]
