import { escapeSsrHtml, serializeSsrState } from './SsrEscape'

export const SSR_HEAD_ATTRIBUTE = 'data-vue-ssr-lite-head'

export interface ManagedHeadMetaEntry {
  key?: string
  name?: string
  property?: string
  httpEquiv?: string
  content: string
}

export interface ManagedHeadLinkEntry {
  key?: string
  rel: string
  href: string
  hreflang?: string
  type?: string
  media?: string
}

export interface ManagedHeadScriptEntry {
  key?: string
  type?: string
  content: string
}

/** Generic head contribution accepted by the core managed-head pipeline. */
export interface ManagedHeadContribution {
  title?: string | null
  meta?: readonly ManagedHeadMetaEntry[]
  links?: readonly ManagedHeadLinkEntry[]
  scripts?: readonly ManagedHeadScriptEntry[]
  htmlAttributes?: Record<string, string | null | undefined>
}

export interface ManagedHeadTag {
  key: string
  tag: 'title' | 'meta' | 'link' | 'script'
  attrs: Record<string, string>
  textContent?: string
}

export interface ManagedHeadSnapshot {
  tags: ManagedHeadTag[]
  htmlAttributes?: Record<string, string | null | undefined>
  title?: string | null
}

interface HeadSource {
  name: string
  read: () => ManagedHeadContribution
}

const SINGLETON_CONFLICTS: ReadonlyArray<{
  key: string
  selector: string
  label: string
}> = [
  { key: 'title', selector: 'title', label: '<title>' },
  {
    key: 'description',
    selector: 'meta[name="description"]',
    label: '<meta name="description">',
  },
  {
    key: 'robots',
    selector: 'meta[name="robots"]',
    label: '<meta name="robots">',
  },
  {
    key: 'canonical',
    selector: 'link[rel="canonical"]',
    label: '<link rel="canonical">',
  },
]

const isProduction = (): boolean =>
  typeof process !== 'undefined' && process.env.NODE_ENV === 'production'

const wrapHeadError = (name: string, cause: unknown): Error => {
  const error = new Error(
    `[vue-ssr-lite] Extension "${name}" failed during head contribution.`
  )
  error.cause = cause
  return error
}

export const metaHeadKey = (entry: ManagedHeadMetaEntry): string => {
  if (entry.key) return entry.key
  return `${entry.name || entry.property || entry.httpEquiv || 'meta'}:${entry.content}`
}

export const linkHeadKey = (entry: ManagedHeadLinkEntry): string => {
  if (entry.key) return entry.key
  return `${entry.rel}:${entry.hreflang || ''}:${entry.media || ''}:${entry.href}`
}

export const flattenHeadContribution = (
  contribution: ManagedHeadContribution
): { tags: ManagedHeadTag[]; htmlAttributes?: ManagedHeadContribution['htmlAttributes'] } => {
  const tags: ManagedHeadTag[] = []
  if (contribution.title != null && contribution.title !== '') {
    tags.push({
      key: 'title',
      tag: 'title',
      attrs: {},
      textContent: contribution.title,
    })
  }
  for (const entry of contribution.meta ?? []) {
    const attrs: Record<string, string> = { content: entry.content }
    if (entry.name) attrs.name = entry.name
    if (entry.property) attrs.property = entry.property
    if (entry.httpEquiv) attrs['http-equiv'] = entry.httpEquiv
    tags.push({ key: metaHeadKey(entry), tag: 'meta', attrs })
  }
  for (const entry of contribution.links ?? []) {
    const attrs: Record<string, string> = { rel: entry.rel, href: entry.href }
    if (entry.hreflang) attrs.hreflang = entry.hreflang
    if (entry.type) attrs.type = entry.type
    if (entry.media) attrs.media = entry.media
    tags.push({ key: linkHeadKey(entry), tag: 'link', attrs })
  }
  for (const entry of contribution.scripts ?? []) {
    tags.push({
      key: entry.key || 'script',
      tag: 'script',
      attrs: entry.type ? { type: entry.type } : {},
      textContent: entry.content,
    })
  }
  return { tags, htmlAttributes: contribution.htmlAttributes }
}

export const serializeJsonLd = (value: unknown): string =>
  serializeSsrState(value).replaceAll('>', '\\u003e')

export const serializeManagedHeadTag = (tag: ManagedHeadTag): string => {
  const marked = `${SSR_HEAD_ATTRIBUTE}="${escapeSsrHtml(tag.key)}"`
  if (tag.tag === 'title') {
    return `<title ${marked}>${escapeSsrHtml(tag.textContent)}</title>`
  }
  const attributes = Object.entries(tag.attrs)
    .filter(([, value]) => value != null && value !== '')
    .map(([name, value]) => `${name}="${escapeSsrHtml(value)}"`)
    .join(' ')
  if (tag.tag === 'script') {
    return `<script ${marked}${attributes ? ` ${attributes}` : ''}>${tag.textContent ?? ''}</script>`
  }
  return `<${tag.tag} ${marked}${attributes ? ` ${attributes}` : ''}>`
}

export const serializeManagedHead = (snapshot: ManagedHeadSnapshot | null): string =>
  (snapshot?.tags ?? []).map(serializeManagedHeadTag).join('')

export const snapshotTitle = (snapshot: ManagedHeadSnapshot | null): string | null => {
  const title = snapshot?.tags.find((tag) => tag.key === 'title')
  return title?.textContent ?? snapshot?.title ?? null
}

const warnStaticConflict = (label: string) => {
  if (isProduction()) return
  console.warn(
    `[vue-ssr-lite] Replacing unmanaged ${label} in the document head. Remove the static duplicate from index.html.`
  )
}

const isManagedElement = (element: Element): boolean =>
  element.hasAttribute(SSR_HEAD_ATTRIBUTE)

export const supersedeUnmanagedHeadTags = (
  documentHead: Pick<ParentNode, 'querySelectorAll'>,
  keys: Iterable<string>
) => {
  const owned = new Set(keys)
  for (const conflict of SINGLETON_CONFLICTS) {
    if (!owned.has(conflict.key)) continue
    for (const element of documentHead.querySelectorAll(conflict.selector)) {
      if (isManagedElement(element)) continue
      warnStaticConflict(conflict.label)
      element.remove()
    }
  }
}

const applyAttributes = (element: Element, attrs: Record<string, string>) => {
  const allowed = new Set(Object.keys(attrs))
  allowed.add(SSR_HEAD_ATTRIBUTE)
  for (const name of [...element.getAttributeNames()]) {
    if (!allowed.has(name)) element.removeAttribute(name)
  }
  for (const [name, value] of Object.entries(attrs)) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value)
  }
}

const createHeadElement = (
  documentRef: Document,
  tag: ManagedHeadTag
): Element => {
  const element = documentRef.createElement(tag.tag)
  element.setAttribute(SSR_HEAD_ATTRIBUTE, tag.key)
  applyAttributes(element, tag.attrs)
  if (tag.tag === 'title' || tag.tag === 'script') {
    element.textContent = tag.textContent ?? ''
  }
  return element
}

export const reconcileManagedHead = (
  documentHead: HTMLElement,
  snapshot: ManagedHeadSnapshot,
  options: { hydrate?: boolean } = {}
) => {
  const documentRef = documentHead.ownerDocument
  const existing = new Map<string, Element>()
  for (const element of documentHead.querySelectorAll(`[${SSR_HEAD_ATTRIBUTE}]`)) {
    existing.set(element.getAttribute(SSR_HEAD_ATTRIBUTE) || '', element)
  }

  supersedeUnmanagedHeadTags(documentHead, snapshot.tags.map((tag) => tag.key))

  const seen = new Set<string>()
  for (const tag of snapshot.tags) {
    seen.add(tag.key)
    const current = existing.get(tag.key)
    if (current) {
      applyAttributes(current, tag.attrs)
      if (
        (tag.tag === 'title' || tag.tag === 'script') &&
        current.textContent !== (tag.textContent ?? '')
      ) {
        current.textContent = tag.textContent ?? ''
      }
      continue
    }
    documentHead.append(createHeadElement(documentRef, tag))
  }

  for (const [key, element] of existing) {
    if (!seen.has(key)) element.remove()
  }

  const title = snapshotTitle(snapshot)
  if (title != null && documentRef.title !== title) {
    documentRef.title = title
  }

  void options.hydrate
}

export const collectManagedHeadSnapshot = (
  sources: readonly HeadSource[]
): ManagedHeadSnapshot => {
  const tags = new Map<string, ManagedHeadTag>()
  let htmlAttributes: ManagedHeadContribution['htmlAttributes']
  for (const source of sources) {
    let contribution: ManagedHeadContribution
    try {
      contribution = source.read()
    } catch (error) {
      throw wrapHeadError(source.name, error)
    }
    const flattened = flattenHeadContribution(contribution)
    for (const tag of flattened.tags) tags.set(tag.key, tag)
    if (flattened.htmlAttributes) {
      htmlAttributes = { ...htmlAttributes, ...flattened.htmlAttributes }
    }
  }
  const list = [...tags.values()]
  return {
    tags: list,
    htmlAttributes,
    title: list.find((tag) => tag.key === 'title')?.textContent ?? null,
  }
}

export interface ManagedHeadController {
  contribute(
    name: string,
    contribution: ManagedHeadContribution | (() => ManagedHeadContribution)
  ): void
  collect(): ManagedHeadSnapshot
  invalidate(): void
  hydrate(documentHead: HTMLElement): void
  dispose(): void
}

export const createManagedHeadController = (
  server: boolean
): ManagedHeadController => {
  const sources: HeadSource[] = []
  let scheduled = false
  let disposed = false
  let hydrated = false

  const snapshot = () => collectManagedHeadSnapshot(sources)

  const flush = () => {
    scheduled = false
    if (disposed || server || typeof document === 'undefined') return
    reconcileManagedHead(document.head, snapshot(), { hydrate: hydrated })
  }

  return {
    contribute(name, contribution) {
      sources.push({
        name,
        read:
          typeof contribution === 'function' ? contribution : () => contribution,
      })
    },
    collect: snapshot,
    invalidate() {
      if (server || disposed || !hydrated) return
      if (scheduled) return
      scheduled = true
      queueMicrotask(flush)
    },
    hydrate(documentHead) {
      if (server || disposed) return
      hydrated = true
      reconcileManagedHead(documentHead, snapshot(), { hydrate: true })
    },
    dispose() {
      disposed = true
      scheduled = false
      sources.length = 0
    },
  }
}
