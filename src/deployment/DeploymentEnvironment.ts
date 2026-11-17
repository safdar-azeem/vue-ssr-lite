export type DeploymentEnvironment = 'node' | 'vercel' | 'netlify' | 'cloudflare'

/** Targets a consumer may select explicitly with `vue-ssr-lite build --target`. */
export const EXPLICIT_DEPLOYMENT_TARGETS = ['cloudflare'] as const
export type ExplicitDeploymentTarget = (typeof EXPLICIT_DEPLOYMENT_TARGETS)[number]

/** Provider-owned build markers only; a URL, NODE_ENV or CI alone is insufficient. */
export const resolveDeploymentEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): DeploymentEnvironment => {
  const vercel = environment.VERCEL === '1' && environment.VERCEL_ENV !== 'development'
  const netlify = environment.NETLIFY === 'true' && environment.NETLIFY_DEV !== 'true'
  if (vercel && netlify) throw new Error('[vue-ssr-lite] Conflicting Vercel and Netlify build environments.')
  return vercel ? 'vercel' : netlify ? 'netlify' : 'node'
}

/**
 * Cloudflare exposes no reliable build marker, so it is only ever selected
 * explicitly. An explicit target describes the artifact being produced and
 * takes precedence over the provider whose CI happens to run the build.
 */
export const resolveDeploymentTarget = (
  explicit: ExplicitDeploymentTarget | undefined,
  environment: Readonly<Record<string, string | undefined>>
): DeploymentEnvironment => explicit ?? resolveDeploymentEnvironment(environment)

export const assertSupportedDeploymentEnvironment = (environment: DeploymentEnvironment): void => {
  if (environment !== 'netlify') return
  throw new Error(
    '[vue-ssr-lite] Netlify deployment is not supported by this version. ' +
    'Netlify’s Vite preset publishes dist, which contains private SSR server artifacts, ' +
    'and its current Frameworks API cannot select a safe publish directory automatically. ' +
    'The build has been stopped to prevent an insecure deployment. ' +
    'Deploy this version on Vercel or a Node host; Netlify requires a future zero-configuration integration. ' +
    'Do not publish dist as a static directory.'
  )
}
