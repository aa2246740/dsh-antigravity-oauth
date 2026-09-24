import { defineConfig } from 'tsdown'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const vendored = fileURLToPath(new URL('./tools/client-build.js', import.meta.url))
const harness = process.env.DSHX_HARNESS
const adapter = existsSync(vendored)
  ? vendored
  : harness
    ? join(resolve(harness), 'tools/dshx/src/client-build.js')
    : undefined
if (!adapter || !existsSync(adapter)) {
  throw new Error('Set DSHX_HARNESS to the checkout used for this build, or keep tools/client-build.js.')
}
const { externalClientBundle } = await import(pathToFileURL(adapter).href)
const client = externalClientBundle('dsh-antigravity-oauth', [], { clientEntry: 'src/client/index.tsx' })[1]

const nodeExternal = [
  /^@deepseek-ai\//,
  /^@earendil-works\//,
  'react',
  'react/jsx-runtime',
]

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      invariant: 'src/invariant.ts',
    },
    platform: 'node',
    format: 'esm',
    dts: true,
    outDir: 'lib',
    fixedExtension: false,
    deps: { neverBundle: nodeExternal },
  },
  client,
])
