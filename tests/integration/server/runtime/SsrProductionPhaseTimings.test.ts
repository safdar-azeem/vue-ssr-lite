import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, onServerPrefetch } from 'vue'
import { RouterView } from 'vue-router'
import { defineApplication, defineServer, defineServerMiddleware } from '../../../../src/index'
import { withSsrShells } from '../../../helpers/SsrTestFixtures'
import { useSsrRequestContext } from '../../../../src/request/SsrRequestContext'
import { createSsrProductionRequestHandler } from '../../../../src/server/runtime/SsrProductionRequestRuntime'
import { normalizeDeploymentRequest } from '../../../../src/deployment/DeploymentRequest'

// Controlled production fixture: every stage of the pre-render and render
// pipeline can be given an exact asynchronous delay, so the phase timings can be
// checked against a known truth instead of a guess.

type Stage = 'runtime' | 'middleware' | 'publicConfig' | 'siteOrigin' | 'seo' | 'endpoint' | 'prefetch'
type Delays = Partial<Record<Stage, number>>

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Top-level phases are contiguous and sum to the request total. The rest are
// nested inside one of them (renderer/template/injection) and are not additive.
const TOP_LEVEL = [
  'runtime', 'host', 'middleware', 'publicConfig', 'siteOrigin', 'seo', 'endpoints',
  'static assets', 'route classification', 'response cache', 'template', 'admission',
  'renderer', 'asset resolution', 'HTML injection', 'response',
]
const NESTED = [
  'app/router creation', 'router navigation', 'Vue render', 'resolution drain',
  'serialization', 'template read', 'template preparation', 'HTML state serialization',
]

interface TimingEvent {
  requestId: string
  applicationId: string
  lifecycle?: string
  phases: Record<string, number> & { total: number }
}

let root = ''
beforeEach(async () => {
  vi.stubEnv('PUBLIC_URL', '')
  vi.stubEnv('NODE_ENV', 'production')
  root = await mkdtemp(join(tmpdir(), 'ssr-phase-timings-'))
  await mkdir(join(root, 'dist/client/.vite'), { recursive: true })
  await writeFile(join(root, 'dist/client/index.html'), '<!doctype html><html><head></head><body><div id="app"></div></body></html>')
  await writeFile(join(root, 'dist/client/.vite/manifest.json'), '{}')
  await writeFile(join(root, 'dist/client/.vite/ssr-manifest.json'), '{}')
  await writeFile(join(root, 'dist/client/.vite/vue-ssr-lite-assets.json'), '{"version":1,"immutable":[]}')
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

const build = (options: {
  delays?: Record<string, Delays>
  phaseTimings?: boolean
  maxConcurrentSsrRequests?: number
}) => {
  const events: TimingEvent[] = []
  const delay = (host: string, stage: Stage) => sleep(options.delays?.[host]?.[stage] ?? 0)
  const logger = {
    debug: (name: unknown, details: unknown) => {
      if (String(name).includes('ssr.diagnostic.timing')) events.push(details as TimingEvent)
    },
  }
  const Page = defineComponent({
    setup() {
      const context = useSsrRequestContext<Record<string, never>, Record<string, never>>()
      onServerPrefetch(() => delay(context.domain.hostname, 'prefetch'))
      return () => h('main', `page:${context.domain.hostname}`)
    },
  })
  const Shell = defineComponent({ setup: () => () => h(RouterView) })
  const apps = ['a', 'b'].map((id) => defineApplication({
    name: id, render: 'ssr', template: 'index.html', domain: { production: `${id}.test` },
    cookies: { allow: ['session'] },
    publicConfig: async (request) => { await delay(request.host, 'publicConfig'); return {} },
    seo: {
      siteUrl: `https://${id}.test`,
      site: {
        resolve: async (context) => {
          await delay(context.domain.hostname, 'seo')
          return { status: 'resolved', defaults: { title: id } }
        },
      },
    },
    routes: [{ path: '/', component: Page }, { path: '/about', component: Page }],
    endpoints: [{
      id: 'slow',
      match: () => true,
      handle: async (request) => { await delay(request.host, 'endpoint'); return null },
    }],
  }))
  const definition = withSsrShells(defineServer({
    server: {
      trustProxy: true,
      logger,
      maxConcurrentSsrRequests: options.maxConcurrentSsrRequests ?? 8,
      ...(options.phaseTimings === false ? {} : { phaseTimings: true }),
    },
    resolveSiteUrl: async (request) => { await delay(request.host, 'siteOrigin'); return undefined },
    serverMiddleware: [defineServerMiddleware(async (request, _context, next) => {
      await delay(new URL(request.url).hostname, 'middleware')
      return next()
    })],
    applications: apps,
  }), { a: { root: Shell }, b: { root: Shell } })
  const loadRuntime = vi.fn(async () => {
    await sleep(options.delays?.runtime?.runtime ?? 0)
    return definition
  })
  const execute = createSsrProductionRequestHandler({ root, loadRuntime })
  const request = (path: string, host: string, requestId = `req-${Math.random().toString(36).slice(2)}`, headers: Record<string, string> = {}) =>
    execute(
      Object.freeze({
        ...normalizeDeploymentRequest({
          method: 'GET', url: path, host, protocol: 'https',
          headers: { accept: 'text/html', ...headers },
        }),
        requestId,
      }),
      new AbortController().signal
    )
  return { events, request, loadRuntime }
}

const eventFor = (events: TimingEvent[], requestId: string) => {
  const event = events.find((candidate) => candidate.requestId === requestId)
  expect(event, `timing event for ${requestId}`).toBeDefined()
  return event!
}
const topLevelSum = (event: TimingEvent) =>
  TOP_LEVEL.reduce((sum, phase) => sum + (event.phases[phase] ?? 0), 0)

describe('production phase timings (opt-in)', () => {
  const D = 160
  const cases: Array<[Stage, string]> = [
    ['middleware', 'middleware'],
    ['publicConfig', 'publicConfig'],
    ['siteOrigin', 'siteOrigin'],
    ['seo', 'seo'],
    ['endpoint', 'endpoints'],
    ['prefetch', 'renderer'],
  ]

  it.each(cases)('attributes a %s delay to the %s phase and to nothing else', async (stage, phase) => {
    const { events, request } = build({ delays: { 'a.test': { [stage]: D } } })
    await (await request('/', 'a.test', 'warm-up-b')).text() // cold start is covered separately
    const response = await request('/', 'a.test', 'measured')
    expect((await response.text())).toContain('page:a.test')
    const event = eventFor(events, 'measured')
    expect(event.phases[phase]).toBeGreaterThanOrEqual(D * 0.9)
    for (const other of TOP_LEVEL) {
      if (other !== phase) expect(event.phases[other] ?? 0, `${other} must not absorb the ${stage} delay`).toBeLessThan(D * 0.6)
    }
    // Phases are contiguous: nothing is unaccounted for.
    expect(Math.abs(topLevelSum(event) - event.phases.total)).toBeLessThan(1)
    expect(event.phases.total).toBeGreaterThanOrEqual(D * 0.9)
  })

  it('reports the server-prefetch wait inside the nested "Vue render" phase', async () => {
    const { events, request } = build({ delays: { 'a.test': { prefetch: D } } })
    await (await request('/', 'a.test', 'warm')).text()
    await (await request('/', 'a.test', 'measured')).text()
    const event = eventFor(events, 'measured')
    expect(event.phases['Vue render']).toBeGreaterThanOrEqual(D * 0.9)
    // Nested phases are contained in "renderer", never added to it.
    expect(event.phases['Vue render']).toBeLessThanOrEqual(event.phases.renderer + 1)
  })

  it('accounts for every injected delay together with no hidden wait', async () => {
    const all: Delays = { middleware: 40, publicConfig: 50, siteOrigin: 60, seo: 70, endpoint: 30, prefetch: 80 }
    const { events, request } = build({ delays: { 'a.test': all } })
    await (await request('/', 'a.test', 'warm')).text()
    await (await request('/', 'a.test', 'measured')).text()
    const event = eventFor(events, 'measured')
    const injected = Object.values(all).reduce((sum, value) => sum + value, 0)
    expect(event.phases.total).toBeGreaterThanOrEqual(injected * 0.95)
    expect(Math.abs(topLevelSum(event) - event.phases.total)).toBeLessThan(1)
    // The unexplained remainder (real work: render, template, injection) stays small.
    const remainder = event.phases.total - injected
    expect(remainder).toBeLessThan(250)
    expect(event.phases.middleware).toBeGreaterThanOrEqual(40 * 0.9)
    expect(event.phases.publicConfig).toBeGreaterThanOrEqual(50 * 0.9)
    expect(event.phases.siteOrigin).toBeGreaterThanOrEqual(60 * 0.9)
    expect(event.phases.seo).toBeGreaterThanOrEqual(70 * 0.9)
    expect(event.phases.endpoints).toBeGreaterThanOrEqual(30 * 0.9)
  })

  it('attributes capacity queueing to the admission phase', async () => {
    const { events, request } = build({
      delays: { 'a.test': { prefetch: 220 } },
      maxConcurrentSsrRequests: 1,
    })
    await (await request('/', 'a.test', 'warm')).text()
    const [first, second] = await Promise.all([
      request('/', 'a.test', 'holder'), request('/about', 'a.test', 'waiter'),
    ])
    await Promise.all([first.text(), second.text()])
    const holder = eventFor(events, 'holder')
    const waiter = eventFor(events, 'waiter')
    expect(holder.phases.admission).toBeLessThan(60)
    expect(waiter.phases.admission).toBeGreaterThanOrEqual(150)
  })

  it('separates the cold start from warm requests', async () => {
    const { events, request, loadRuntime } = build({ delays: { runtime: { runtime: 180 } } })
    await (await request('/', 'a.test', 'cold')).text()
    await (await request('/', 'a.test', 'warm')).text()
    expect(loadRuntime).toHaveBeenCalledOnce()
    const cold = eventFor(events, 'cold')
    const warm = eventFor(events, 'warm')
    expect(cold.lifecycle).toBe('first-ssr')
    expect(warm.lifecycle).toBe('warm-ssr')
    // Initialization happens before the handler runs; the origin is the arrival time.
    expect(cold.phases.runtime).toBeGreaterThanOrEqual(180 * 0.9)
    expect(warm.phases.runtime).toBeLessThan(30)
    expect(Math.abs(topLevelSum(cold) - cold.phases.total)).toBeLessThan(1)
  })

  it('keeps concurrent requests to different hosts separate', async () => {
    const { events, request } = build({
      delays: { 'a.test': { publicConfig: 140 }, 'b.test': { siteOrigin: 140 } },
    })
    await (await request('/', 'a.test', 'warm-a')).text()
    await (await request('/', 'b.test', 'warm-b')).text()
    events.length = 0
    const ids = Array.from({ length: 12 }, (_, index) => `${index % 2 === 0 ? 'a' : 'b'}-${index}`)
    const responses = await Promise.all(ids.map((id) => request(`/?n=${id}`, `${id[0]}.test`, id)))
    await Promise.all(responses.map((response) => response.text()))
    expect(events).toHaveLength(ids.length)
    for (const id of ids) {
      const event = eventFor(events, id)
      expect(event.applicationId).toBe(id[0])
      if (id[0] === 'a') {
        expect(event.phases.publicConfig).toBeGreaterThanOrEqual(140 * 0.9)
        expect(event.phases.siteOrigin).toBeLessThan(80)
      } else {
        expect(event.phases.siteOrigin).toBeGreaterThanOrEqual(140 * 0.9)
        expect(event.phases.publicConfig).toBeLessThan(80)
      }
    }
  })

  it('is disabled by default and leaves the Server-Timing contract unchanged', async () => {
    const off = build({ phaseTimings: false })
    const response = await off.request('/', 'a.test')
    await response.text()
    expect(off.events).toEqual([])
    expect(response.headers.get('server-timing')).toMatch(/^context;dur=[\d.]+, route;dur=[\d.]+, render;dur=[\d.]+$/)
    const on = build({})
    const traced = await on.request('/', 'a.test')
    await traced.text()
    expect(on.events).toHaveLength(1)
    expect(traced.headers.get('server-timing')).toMatch(/^context;dur=[\d.]+, route;dur=[\d.]+, render;dur=[\d.]+$/)
  })

  it('does not change the response', async () => {
    const off = build({ phaseTimings: false })
    const on = build({})
    const one = await off.request('/about', 'a.test', 'x')
    const two = await on.request('/about', 'a.test', 'x')
    expect(two.status).toBe(one.status)
    expect(await two.text()).toBe(await one.text())
    for (const name of ['content-type', 'cache-control', 'vary']) {
      expect(two.headers.get(name)).toBe(one.headers.get(name))
    }
  })

  it('emits only fixed phase names and never request data', async () => {
    const { events, request } = build({})
    const response = await request('/about?token=SECRET-QUERY', 'a.test', 'private-1', {
      cookie: 'session=SECRET-COOKIE',
      authorization: 'Bearer SECRET-AUTH',
    })
    await response.text()
    expect(events).toHaveLength(1)
    const serialized = JSON.stringify(events)
    for (const secret of ['SECRET-QUERY', 'SECRET-COOKIE', 'SECRET-AUTH', '/about', 'a.test']) {
      expect(serialized).not.toContain(secret)
    }
    for (const name of Object.keys(events[0]!.phases)) {
      expect([...TOP_LEVEL, ...NESTED, 'total']).toContain(name)
    }
    expect(Object.keys(events[0]!).sort()).toEqual(['applicationId', 'lifecycle', 'phases', 'readyToRequestMs', 'requestId'])
  })
})
