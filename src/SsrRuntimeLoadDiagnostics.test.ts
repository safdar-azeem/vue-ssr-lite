import { describe, expect, it } from 'vitest'
import { createSsrOperatorLogDetails } from './SsrErrorDiagnostic'
import { markSsrInitializationFailure } from './SsrProductionError'
import {
  assertSsrRuntimeModuleExport,
  classifySsrRuntimeLoadFailure,
  createSsrRuntimeLoadFailure,
  readSsrRuntimeLoadFailure,
  sanitizeSsrRuntimeLoadClassification,
} from './SsrRuntimeLoadDiagnostics'

const NODE_ESM_FRAME = '    at ModuleJob._instantiate (node:internal/modules/esm/module_job.js:123:9)'
const VITE_LOADER_FRAME = '    at loadAndTransform (file:///node_modules/vite/dist/node/chunks/dep.js:1:1)'

const withNodeEsmStack = <T extends Error>(error: T): T => {
  error.stack = `${error.name}: ${error.message}\n${NODE_ESM_FRAME}`
  return error
}

const withViteStack = <T extends Error>(error: T): T => {
  error.stack = `${error.name}: ${error.message}\n${VITE_LOADER_FRAME}`
  return error
}

const nodeError = (message: string, code?: string, name: 'Error' | 'SyntaxError' = 'Error') => {
  const error = name === 'SyntaxError' ? new SyntaxError(message) : new Error(message)
  if (code) Object.assign(error, { code })
  return error
}

const FIXTURE_PACKAGE = 'fixture-runtime-package'
const FIXTURE_EXPORT = 'missingExport'
const VITE_NAMED_EXPORT_MESSAGE =
  `[vite] Named export '${FIXTURE_EXPORT}' not found. The requested module '${FIXTURE_PACKAGE}' is a CommonJS module, which may not support all module.exports as named exports.`

describe('runtime-load classification', () => {
  it.each([
    {
      reason: 'missing-runtime-dependency',
      error: withNodeEsmStack(nodeError(
        `Cannot find package '${FIXTURE_PACKAGE}' imported from /private/build/user/project/SsrRuntime.js`,
        'ERR_MODULE_NOT_FOUND'
      )),
      details: { package: FIXTURE_PACKAGE },
    },
    {
      reason: 'missing-named-export',
      error: withNodeEsmStack(nodeError(
        `The requested module '${FIXTURE_PACKAGE}' does not provide an export named '${FIXTURE_EXPORT}'`,
        undefined,
        'SyntaxError'
      )),
      details: { package: FIXTURE_PACKAGE, export: FIXTURE_EXPORT },
    },
    {
      reason: 'missing-named-export',
      error: nodeError(VITE_NAMED_EXPORT_MESSAGE),
      details: {},
    },
    {
      reason: 'missing-named-export',
      error: withViteStack(nodeError(VITE_NAMED_EXPORT_MESSAGE)),
      details: { package: FIXTURE_PACKAGE, export: FIXTURE_EXPORT },
    },
    {
      reason: 'invalid-module-export',
      error: nodeError(
        'Package subpath \'./secret\' is not defined by "exports" in /private/build/node_modules/pkg/package.json',
        'ERR_PACKAGE_PATH_NOT_EXPORTED'
      ),
      details: {},
    },
    {
      reason: 'module-format-incompatibility',
      error: nodeError(
        'require() of ES Module /private/build/file.js from /private/build/other.js not supported.',
        'ERR_REQUIRE_ESM'
      ),
      details: {},
    },
    {
      reason: 'module-syntax-error',
      error: nodeError("Unexpected token '{'", undefined, 'SyntaxError'),
      details: {},
    },
    {
      reason: 'invalid-runtime-export',
      error: createSsrRuntimeLoadFailure('invalid-runtime-export'),
      details: {},
    },
    {
      reason: 'runtime-load-failed',
      error: nodeError('private-token /private/SsrRuntime.js\nsecret stack', undefined, 'SyntaxError'),
      details: {},
    },
  ])('classifies $reason without copying exception text', ({ reason, error, details }) => {
    expect(classifySsrRuntimeLoadFailure(error)).toEqual({ reason, ...details })
    expect(JSON.stringify(classifySsrRuntimeLoadFailure(error))).not.toMatch(/private|secret|SsrRuntime|stack|token=\{/)
  })

  it('keeps a validated package name and drops absolute paths from the same message', () => {
    expect(classifySsrRuntimeLoadFailure(withNodeEsmStack(nodeError(
      `Cannot find package '${FIXTURE_PACKAGE}' imported from /private/build/user/project/SsrRuntime.js\nRequire stack:\n- /private/build/index.js`,
      'ERR_MODULE_NOT_FOUND'
    )))).toEqual({ reason: 'missing-runtime-dependency', package: FIXTURE_PACKAGE })
  })

  it('omits path-like specifiers and unbounded quoted values', () => {
    expect(classifySsrRuntimeLoadFailure(withNodeEsmStack(new SyntaxError(
      `The requested module 'file:///private/build/runtime.js' does not provide an export named '${FIXTURE_EXPORT}'`
    )))).toEqual({ reason: 'missing-named-export', export: FIXTURE_EXPORT })
    expect(classifySsrRuntimeLoadFailure(withNodeEsmStack(new SyntaxError(
      `The requested module '/private/build/runtime.js' does not provide an export named '${FIXTURE_EXPORT}'`
    )))).toEqual({ reason: 'missing-named-export', export: FIXTURE_EXPORT })
    expect(classifySsrRuntimeLoadFailure(nodeError(
      "Cannot find module './secret.js' imported from /private/build/SsrRuntime.js",
      'ERR_MODULE_NOT_FOUND'
    ))).toEqual({ reason: 'missing-runtime-dependency' })
  })

  it('does not promote spoofed Node-looking application errors into structured identifiers', () => {
    expect(classifySsrRuntimeLoadFailure(new Error(
      "The requested module 'secret-password' does not provide an export named 'privateToken'"
    ))).toEqual({ reason: 'runtime-load-failed' })
    expect(classifySsrRuntimeLoadFailure(new Error(
      "Cannot find package 'secret-password' imported from /private/build/user/project/SsrRuntime.js"
    ))).toEqual({ reason: 'runtime-load-failed' })
    expect(classifySsrRuntimeLoadFailure(new Error(
      "Named export 'privateToken' not found. The requested module 'secret-password' is a CommonJS module, which may not support all module.exports as named exports."
    ))).toEqual({ reason: 'runtime-load-failed' })
    expect(classifySsrRuntimeLoadFailure(new Error(
      "[vite] Named export 'privateToken' not found. The requested module 'secret-password' is a CommonJS module, which may not support all module.exports as named exports."
    ))).toEqual({ reason: 'missing-named-export' })
    expect(classifySsrRuntimeLoadFailure(Object.assign(
      new Error("Cannot find package 'secret-password' imported from /private/build/user/project/SsrRuntime.js"),
      { code: 'ERR_MODULE_NOT_FOUND' }
    ))).toEqual({ reason: 'missing-runtime-dependency' })
    const spoofedSyntax = new SyntaxError(
      "The requested module 'secret-password' does not provide an export named 'privateToken'"
    )
    spoofedSyntax.stack = `${spoofedSyntax.name}: ${spoofedSyntax.message}\n    at Object.run (/app/server.ts:10:5)`
    expect(classifySsrRuntimeLoadFailure(spoofedSyntax)).toEqual({ reason: 'missing-named-export' })
  })

  it('does not stringify non-Error throws or walk nested causes', () => {
    expect(classifySsrRuntimeLoadFailure('secret string')).toEqual({ reason: 'runtime-load-failed' })
    expect(classifySsrRuntimeLoadFailure({ message: 'secret', cause: { password: 'secret' } })).toEqual({
      reason: 'runtime-load-failed',
    })
    const nested = Object.assign(new Error('wrapper'), {
      cause: nodeError(`Cannot find package '${FIXTURE_PACKAGE}' imported from /private/file.js`, 'ERR_MODULE_NOT_FOUND'),
    })
    expect(classifySsrRuntimeLoadFailure(nested)).toEqual({ reason: 'runtime-load-failed' })
  })

  it('rejects planted identifiers that fail sanitization', () => {
    expect(sanitizeSsrRuntimeLoadClassification({
      reason: 'missing-named-export',
      package: `/private/build/${FIXTURE_PACKAGE}`,
      module: 'https://evil.test/module',
      export: `${FIXTURE_EXPORT}; process.env`,
    })).toEqual({ reason: 'missing-named-export' })
    expect(readSsrRuntimeLoadFailure({
      [Symbol.for('vue-ssr-lite.internal.runtime-load-failure')]: {
        reason: 'consumer-secret',
        package: FIXTURE_PACKAGE,
      },
    })).toBeUndefined()
  })

  it('keeps classification structured while operator logs may include the loader message', () => {
    const error = withNodeEsmStack(nodeError(
      `The requested module '${FIXTURE_PACKAGE}' does not provide an export named '${FIXTURE_EXPORT}'`,
      undefined,
      'SyntaxError'
    ))
    expect(classifySsrRuntimeLoadFailure(error)).toEqual({
      reason: 'missing-named-export',
      package: FIXTURE_PACKAGE,
      export: FIXTURE_EXPORT,
    })
    const details = createSsrOperatorLogDetails({
      error: markSsrInitializationFailure(error, 'runtime-load'),
    })
    expect(details).toMatchObject({
      reason: 'missing-named-export',
      package: FIXTURE_PACKAGE,
      export: FIXTURE_EXPORT,
      message: expect.stringContaining('does not provide an export named'),
    })
    expect(JSON.stringify(classifySsrRuntimeLoadFailure(error))).not.toContain('does not provide')
  })

  it('rejects module namespaces that do not default-export a runtime contract', () => {
    expect(() => assertSsrRuntimeModuleExport(null)).toThrowError(/invalid-runtime-export/)
    expect(() => assertSsrRuntimeModuleExport('secret')).toThrowError(/invalid-runtime-export/)
    expect(() => assertSsrRuntimeModuleExport({
      [Symbol.toStringTag]: 'Module',
    })).toThrowError(/invalid-runtime-export/)
    expect(() => assertSsrRuntimeModuleExport({ applications: [] })).not.toThrow()
    expect(() => assertSsrRuntimeModuleExport(() => ({ applications: [] }))).not.toThrow()
    expect(() => assertSsrRuntimeModuleExport({
      [Symbol.toStringTag]: 'Module',
      default: () => ({ applications: [] }),
    })).not.toThrow()
  })
})
