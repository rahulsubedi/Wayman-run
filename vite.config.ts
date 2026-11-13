import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset URLs so dist/ works from any path (file server sub-folder, itch.io, etc.).
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
