import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name?: string
  main?: string
  files?: string[]
  scripts?: Record<string, string>
  keywords?: string[]
  dsh?: { bundle?: { patch?: string } }
}
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const readmeZh = readFileSync(join(root, 'README.zh.md'), 'utf8')
const stockCommand = 'dsh plugin --profile web add github:aa2246740/dsh-antigravity-oauth'

describe('stock dsh plugin add', () => {
  it('can mount this package as a bundle without prepare', () => {
    expect(pkg.name).toBe('dsh-antigravity-oauth')
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(pkg.main).toBe('lib/index.js')
    expect(pkg.scripts?.prepare).toBeUndefined()
    expect(existsSync(join(root, 'cordis.patch.yml'))).toBe(true)
    expect(existsSync(join(root, 'lib/index.js'))).toBe(true)
    expect(existsSync(join(root, 'lib/client.js'))).toBe(true)
    expect(existsSync(join(root, 'lib/invariant.js'))).toBe(true)
    expect(pkg.files).toContain('lib')
    expect(pkg.files).toContain('cordis.patch.yml')
    expect(pkg.keywords).toContain('dsh-plugin')
  })

  it.each([
    ['README.md', readme, /restart that Host and reload the page/i],
    ['README.zh.md', readmeZh, /重启这个 Host，再刷新页面/],
  ] as const)('%s leads with the official stock install and does not default to DSHX', (_label, text, reload) => {
    const heading = text.indexOf('# dsh-antigravity-oauth')
    const command = text.indexOf(stockCommand)
    const warning = text.search(/## Warning|## 警告/)
    expect(heading).toBeGreaterThanOrEqual(0)
    expect(command).toBeGreaterThan(heading)
    expect(command).toBeLessThan(warning)
    expect(text).toMatch(/\bpnpm\b/)
    expect(text).toMatch(reload)
    expect(text).not.toMatch(/\bmy-plugins\b/)
    expect(text).not.toMatch(/\bdshx\b/i)
    expect(text).not.toMatch(/DSHX_HARNESS/)
  })
})
