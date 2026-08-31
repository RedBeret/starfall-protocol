import { defineConfig } from 'vite';

export default defineConfig({
  base: '/starfall-protocol/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
