import { resolve } from 'node:path'
import type { SsrCompiledConfig } from '../SsrConfigCompileRuntime'
import { createSsrCookieFilter, createSsrHostResolver } from './SsrHostRuntime'

const compileMetadata = (definition: SsrCompiledConfig) => ({
  resolveHost: createSsrHostResolver(definition.applications),
  protectedTemplates: Object.freeze(definition.applications.map((entry) => entry.template)),
  applications: new Map(definition.applications.map((entry) => [entry, {
    templatePath: resolve(definition.server.root, entry.template),
    filterCookie: createSsrCookieFilter(entry.cookieAllowlist, entry.cookieDenylist),
  }])),
})

const metadata = new WeakMap<SsrCompiledConfig, ReturnType<typeof compileMetadata>>()

/** Immutable lookup metadata owned by one compiled revision, never by a URL. */
export const prepareSsrCompiledMetadata = (definition: SsrCompiledConfig) => {
  let prepared = metadata.get(definition)
  if (!prepared) {
    prepared = compileMetadata(definition)
    metadata.set(definition, prepared)
  }
  return prepared
}
