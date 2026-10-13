import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: { SAKURA_UPDATES_AUTO_CHECK: '0' },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
