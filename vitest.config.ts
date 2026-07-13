import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // tsconfig has "jsx": "preserve" (Next.js); force the automatic runtime so
  // .tsx test files compile under vitest without @testing-library or jsdom.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // A few tests (e.g. boardLogic.test.ts pre-move characterization) import
    // 'use client' modules that transitively construct the browser supabase
    // client at module scope (src/lib/supabase.ts); it throws without these.
    // Fake values only — no test hits the network with this client.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
    },
  },
});
