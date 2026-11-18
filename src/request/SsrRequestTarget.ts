const INTERNAL_ORIGIN = 'http://internal'

/**
 * Parse the request target a deployment adapter supplies (`pathname + search`)
 * without ever letting it choose a host.
 *
 * `new URL('//x.php', base)` is a protocol-relative reference: the WHATWG parser
 * reads `x.php` as the host and returns pathname `/`, and `new URL('//', base)`
 * throws. An origin-form target has no authority, so the origin is fixed and the
 * target is appended to it. The parser then normalizes `/\x` and tab/newline
 * variants into a pathname that begins with `//`, which this rejects as well.
 *
 * Returns `undefined` for a target that is not a valid origin-form path: a
 * pathname beginning with `//`, a leading backslash, or one the URL parser
 * cannot represent. Callers answer those with a client error. Percent-encoding
 * is left untouched here (no decoding), so it cannot be decoded twice.
 */
export const parseSsrRequestTarget = (target: string): URL | undefined => {
  const raw = target || '/'
  const first = raw.charCodeAt(0)
  // 92 is a backslash: not a valid origin-form target, and the URL parser would
  // read it as a path separator and then as an authority delimiter.
  if (first === 92) return undefined
  try {
    // 47 is a slash. Anything else (absolute-form, `*`) keeps the base-relative
    // parse; only pathname and search are consumed from the result.
    const url = first === 47 ? new URL(`${INTERNAL_ORIGIN}${raw}`) : new URL(raw, INTERNAL_ORIGIN)
    return url.pathname.startsWith('//') ? undefined : url
  } catch {
    return undefined
  }
}
