import { describe, expect, it } from 'vitest'
import { assertSupportedDeploymentEnvironment, resolveDeploymentEnvironment } from '../DeploymentEnvironment'
import { createDeploymentBuild } from '../DeploymentRuntime'

describe('internal deployment selection', () => {
  it.each([
    [{}, 'node'],
    [{ NODE_ENV: 'production', CI: 'true', VERCEL_URL: 'preview.vercel.app' }, 'node'],
    [{ VERCEL: '0', NETLIFY: 'false' }, 'node'],
    [{ VERCEL: '1' }, 'vercel'],
    [{ VERCEL: '1', VERCEL_ENV: 'preview' }, 'vercel'],
    [{ VERCEL: '1', VERCEL_ENV: 'production' }, 'vercel'],
    [{ VERCEL: '1', VERCEL_ENV: 'development' }, 'node'],
    [{ NETLIFY: 'true', CONTEXT: 'deploy-preview' }, 'netlify'],
    [{ NETLIFY: 'true', CONTEXT: 'production' }, 'netlify'],
    [{ NETLIFY: 'true', NETLIFY_DEV: 'true' }, 'node'],
  ] as const)('interprets provider markers %j as %s', (environment, expected) => {
    expect(resolveDeploymentEnvironment(Object.freeze(environment))).toBe(expected)
  })

  it('rejects ambiguous providers instead of choosing by incidental order', () => {
    expect(() => resolveDeploymentEnvironment({ VERCEL: '1', NETLIFY: 'true' })).toThrow(/Conflicting/)
  })

  it('ordinary builds install no hooks and produce no provider projection', async () => {
    const build = createDeploymentBuild('/does-not-exist', {})
    expect(build.plugins).toEqual([])
    await expect(build.complete('/does-not-exist/dist/server/SsrRuntime.js')).resolves.toBeUndefined()
  })

  it('blocks Netlify before building, without requiring a consumer workaround', () => {
    expect(() => assertSupportedDeploymentEnvironment('netlify')).toThrow(/not supported by this version/)
    expect(() => createDeploymentBuild('/unused', { NETLIFY: 'true' })).toThrow(/private SSR server artifacts/)
    expect(() => assertSupportedDeploymentEnvironment('vercel')).not.toThrow()
    expect(() => assertSupportedDeploymentEnvironment('node')).not.toThrow()
  })
})
