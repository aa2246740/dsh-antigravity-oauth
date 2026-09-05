import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // OAuth callback integration suites share the registered port 51121.
    fileParallelism: false,
    include: ['tests/**/*.spec.ts'],
  },
})
