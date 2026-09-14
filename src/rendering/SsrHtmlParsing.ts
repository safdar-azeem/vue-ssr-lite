// Native scans skip runs of template text. Keep token boundaries explicit:
// quoted '>' characters, attribute suffixes, and duplicate ids are significant.
// These synchronous scanners contain no cache of HTML or request data.
const TAG_NAME = /[A-Za-z][A-Za-z0-9:-]*/y
const TAG_BOUNDARY = /["'>]/g
const ATTRIBUTE_LEADING_SPACE = /[\s/]+/y
const ATTRIBUTE_SPACE = /\s+/y
const ATTRIBUTE_NAME = /[^\s=/>]+/y
const UNQUOTED_VALUE = /[^\s>]+/y

export const readSsrHtmlStartTag = (source: string, start: number) => {
  TAG_NAME.lastIndex = start + 1
  const name = TAG_NAME.exec(source)?.[0]
  if (!name) return undefined
  const attributesStart = TAG_NAME.lastIndex
  TAG_BOUNDARY.lastIndex = attributesStart
  for (let boundary = TAG_BOUNDARY.exec(source); boundary; boundary = TAG_BOUNDARY.exec(source)) {
    if (boundary[0] === '>') {
      return {
        name,
        attributes: source.slice(attributesStart, boundary.index),
        end: boundary.index + 1,
      }
    }
    const quoteEnd = source.indexOf(boundary[0], boundary.index + 1)
    if (quoteEnd < 0) return undefined
    TAG_BOUNDARY.lastIndex = quoteEnd + 1
  }
  return undefined
}

export const readSsrHtmlAttributes = (source: string): [string, string][] => {
  const attributes: [string, string][] = []
  let index = 0
  while (index < source.length) {
    ATTRIBUTE_LEADING_SPACE.lastIndex = index
    if (ATTRIBUTE_LEADING_SPACE.exec(source)) index = ATTRIBUTE_LEADING_SPACE.lastIndex
    ATTRIBUTE_NAME.lastIndex = index
    const name = ATTRIBUTE_NAME.exec(source)?.[0]
    if (!name) {
      index += 1
      continue
    }
    index = ATTRIBUTE_NAME.lastIndex
    ATTRIBUTE_SPACE.lastIndex = index
    if (ATTRIBUTE_SPACE.exec(source)) index = ATTRIBUTE_SPACE.lastIndex
    let value = ''
    if (source[index] === '=') {
      index += 1
      ATTRIBUTE_SPACE.lastIndex = index
      if (ATTRIBUTE_SPACE.exec(source)) index = ATTRIBUTE_SPACE.lastIndex
      const quote = source[index]
      if (quote === '"' || quote === "'") {
        const end = source.indexOf(quote, index + 1)
        value = source.slice(index + 1, end < 0 ? source.length : end)
        index = end < 0 ? source.length : end + 1
      } else {
        UNQUOTED_VALUE.lastIndex = index
        value = UNQUOTED_VALUE.exec(source)?.[0] ?? ''
        index += value.length
      }
    }
    attributes.push([name.toLowerCase(), value])
  }
  return attributes
}
