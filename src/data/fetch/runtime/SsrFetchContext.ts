import type { SetContextOptions } from '../types/SsrFetchTypes'

type StoredHeader = readonly [name: string, value: string]

/** Application-owned, replacement-only request defaults. */
export class SsrFetchContext {
  private headers: readonly StoredHeader[] = Object.freeze([])

  replace(context: SetContextOptions): void {
    const headers = new Headers(context.headers)
    this.headers = Object.freeze(
      [...headers.entries()].map(
        ([name, value]) => Object.freeze([name, value]) as StoredHeader
      )
    )
  }

  snapshot(): Headers {
    const headers = new Headers()
    for (const [name, value] of this.headers) headers.append(name, value)
    return headers
  }

  clear(): void {
    this.headers = Object.freeze([])
  }
}
