import { defineConfig } from 'tsdown'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const harness = process.env.DSHX_HARNESS
if (!harness) throw new Error('Set DSHX_HARNESS to the checkout used for this build.')
const { externalClientBundle } = await import(pathToFileURL(resolve(harness, 'tools/dshx/src/client-build.js')).href)
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
