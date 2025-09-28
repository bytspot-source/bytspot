import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.js'],
    deps: {
      inline: [/fastify/, /socket\.io/, /stripe/],
    },
    isolate: false,
  },
  esbuild: {
    target: 'es2020',
    format: 'esm',
  },
});

