import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 60000,
    hookTimeout: 60000
  }
})
