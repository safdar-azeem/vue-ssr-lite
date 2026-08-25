export interface SsrProductionTemplateStore {
  load: (templatePath: string) => Promise<string>
  prepare: (templatePath: string, mountSelector: string) => Promise<string>
}

export interface SsrProductionTemplateStoreOptions {
  load: (templatePath: string) => Promise<string>
  prepare: (source: string, mountSelector: string) => string
}

/**
 * Stores immutable production template work for one managed-server lifetime.
 * Rejected in-flight work is evicted so a later request can retry.
 */
export const createSsrProductionTemplateStore = (
  options: SsrProductionTemplateStoreOptions
): SsrProductionTemplateStore => {
  const sources = new Map<string, Promise<string>>()
  const prepared = new Map<string, Map<string, Promise<string>>>()

  const load = (templatePath: string): Promise<string> => {
    const existing = sources.get(templatePath)
    if (existing) return existing

    const pending = Promise.resolve().then(() => options.load(templatePath))
    sources.set(templatePath, pending)
    void pending.catch(() => {
      if (sources.get(templatePath) === pending) sources.delete(templatePath)
    })
    return pending
  }

  const prepare = (templatePath: string, mountSelector: string): Promise<string> => {
    let byMountSelector = prepared.get(templatePath)
    if (!byMountSelector) {
      byMountSelector = new Map()
      prepared.set(templatePath, byMountSelector)
    }
    const existing = byMountSelector.get(mountSelector)
    if (existing) return existing

    const pending = load(templatePath).then((source) => options.prepare(source, mountSelector))
    byMountSelector.set(mountSelector, pending)
    void pending.catch(() => {
      if (byMountSelector?.get(mountSelector) === pending) {
        byMountSelector.delete(mountSelector)
        if (byMountSelector.size === 0) prepared.delete(templatePath)
      }
    })
    return pending
  }

  return { load, prepare }
}
