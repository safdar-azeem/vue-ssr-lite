import type { Router } from 'vue-router'
import type { SsrLogger } from './SsrRuntimeTypes'
import { safeSsrLog } from './SsrObservability'

// The transport and renderer can live in different Vite module graphs. Carry
// only this request's diagnostic collector across that boundary, without a
// public request field or a process-global request store.
const PHASE_TIMINGS = Symbol.for('vue-ssr-lite.internal.phase-timings')

export const hasSsrTimingSink = (logger: SsrLogger | undefined): boolean => {
  try {
    return typeof logger?.debug === 'function'
  } catch {
    return false
  }
}

export const createSsrPhaseTimings = () => {
  const startedAt = performance.now()
  let checkpoint = startedAt
  const phases: Record<string, number> = Object.create(null)
  const add = (phase: string, duration: number) => {
    phases[phase] = (phases[phase] ?? 0) + duration
  }
  return {
    mark(phase: string) {
      const at = performance.now()
      add(phase, at - checkpoint)
      checkpoint = at
    },
    start(phase: string) {
      const at = performance.now()
      return () => add(phase, performance.now() - at)
    },
    report(
      logger: SsrLogger | undefined,
      requestId: string,
      applicationId: string,
      context: Record<string, unknown> = { lifecycle: 'request' }
    ) {
      if (!hasSsrTimingSink(logger)) return
      const details = {
        ...context,
        requestId,
        applicationId,
        // renderer/template/injection totals contain their named subphases;
        // nested timings are not additional time to add to the request total.
        phases: { ...phases, total: performance.now() - startedAt },
      }
      safeSsrLog(logger, 'debug', 'ssr.diagnostic.timing', details)
    },
  }
}

export type SsrPhaseTimings = ReturnType<typeof createSsrPhaseTimings>

export const attachSsrPhaseTimings = (request: object, timings: SsrPhaseTimings): void => {
  Object.defineProperty(request, PHASE_TIMINGS, { value: timings })
}

export const readSsrPhaseTimings = (request: object): SsrPhaseTimings | undefined =>
  (request as { [PHASE_TIMINGS]?: SsrPhaseTimings })[PHASE_TIMINGS]

/**
 * Development-only render diagnostics.
 *
 * These surface the failure modes that otherwise ship silently to search
 * engines: a server render that still shows a spinner, a route that matched no
 * component, or a body that resolved to nothing. Every check is a pure string /
 * route inspection with no side effects, and the caller only runs them when
 * diagnostics are enabled, so production render paths are untouched.
 */

export interface SsrRenderDiagnosticInput {
  html: string
  route?: Router['currentRoute']['value'] | null
  requestUrl: string
  applicationId: string
}

export interface SsrRenderDiagnostic {
  code:
    | 'loading-placeholder'
    | 'empty-route'
    | 'empty-content'
    | 'busy-attribute'
  message: string
}

// Markers that indicate a not-yet-resolved UI leaked into the final server
// output. Deliberately conservative to avoid flagging real content.
const LOADING_TEXT_PATTERNS: RegExp[] = [
  /\baria-busy=["']true["']/i,
  /\brole=["']status["'][^>]*>\s*(?:<[^>]+>\s*)*(?:loading|please wait)/i,
  /\b(?:class|data-testid)=["'][^"']*\bspinner\b[^"']*["']/i,
  /\bclass=["'][^"']*\banimate-pulse\b[^"']*["']/i,
  />\s*Loading(?:\s|<|\.|…|&hellip;)/i,
]

const stripTags = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export const collectSsrRenderDiagnostics = (
  input: SsrRenderDiagnosticInput
): SsrRenderDiagnostic[] => {
  const diagnostics: SsrRenderDiagnostic[] = []
  const { html } = input

  for (const pattern of LOADING_TEXT_PATTERNS) {
    if (pattern.test(html)) {
      const busy = /\baria-busy=["']true["']/i.test(html)
      diagnostics.push({
        code: busy ? 'busy-attribute' : 'loading-placeholder',
        message: busy
          ? 'Server output still contains aria-busy="true"; a live region is reporting a busy state that will be absent for crawlers. Resolve the data before the render completes (see ssrWatch / onServerPrefetch).'
          : 'Server output still contains a loading placeholder after resolution completed. A non-sync watcher or onMounted hook likely started the work; move it to onServerPrefetch or the ssrWatch primitive so the server awaits it.',
      })
      break
    }
  }

  if (input.route && input.route.matched.length === 0) {
    diagnostics.push({
      code: 'empty-route',
      message: `No route matched "${input.requestUrl}" for application "${input.applicationId}". The renderer produced a 404; add a catch-all route record or a not-found component so matched components render real content.`,
    })
  }

  if (stripTags(html).length === 0) {
    diagnostics.push({
      code: 'empty-content',
      message: `Server render for "${input.applicationId}" produced no textual content. Verify the root component's data resolved during the server render rather than in a discarded watcher.`,
    })
  }

  return diagnostics
}
