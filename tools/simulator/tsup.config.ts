import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/live.ts', 'src/backfill.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  // Bundle the workspace package (it ships TypeScript source); keep real npm deps external.
  noExternal: ['@puzzlelove/shared'],
});
