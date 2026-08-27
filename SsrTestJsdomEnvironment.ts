import { TextDecoder, TextEncoder } from 'node:util'
import { builtinEnvironments, type Environment } from 'vitest/runtime'

const nodeBinaryGlobals: Array<readonly [string, unknown]> = [
  ['TextEncoder', TextEncoder],
  ['TextDecoder', TextDecoder],
  ['Uint8Array', Uint8Array],
  ['ArrayBuffer', ArrayBuffer],
  ['DataView', DataView],
  ['Int8Array', Int8Array],
  ['Uint8ClampedArray', Uint8ClampedArray],
  ['Int16Array', Int16Array],
  ['Uint16Array', Uint16Array],
  ['Int32Array', Int32Array],
  ['Uint32Array', Uint32Array],
  ['Float32Array', Float32Array],
  ['Float64Array', Float64Array],
  ['BigInt64Array', BigInt64Array],
  ['BigUint64Array', BigUint64Array],
]

const patchBinaryGlobals = (target: object) => {
  for (const [key, value] of nodeBinaryGlobals) {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      writable: true,
      value,
    })
  }
}

/**
 * jsdom with Node ArrayBuffer/TextEncoder identities so Vite's esbuild can run
 * in the same worker as a browser-like document.
 */
const SsrTestJsdomEnvironment: Environment = {
  name: 'jsdom-esbuild',
  viteEnvironment: 'ssr',
  async setup(global, options) {
    const environment = await builtinEnvironments.jsdom.setup(global, options)
    patchBinaryGlobals(global)
    patchBinaryGlobals(globalThis)
    if (global.window && global.window !== global) {
      patchBinaryGlobals(global.window)
    }
    return environment
  },
}

export default SsrTestJsdomEnvironment
