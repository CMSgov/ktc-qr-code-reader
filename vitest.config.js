import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/__tests__/**/*.js',
      'data/**/__tests__/**/*.js',
      'test/**/*.test.js',
      'packages/**/__tests__/**/*.js',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/public/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.js', 'data/**/*.js'],
      exclude: [
        '**/*.test.js',
        '**/node_modules/**',
        '**/dist/**',
        // Integration-heavy or I/O-only code; 80% threshold applies to the rest
        'src/cli.js',
        'src/input/**/*.js',
        'src/output/**/*.js',
        'src/shl/manifest.js',
        'src/shl/decryptor.js',
        'src/shl/fhir-extractor.js', // extraction paths need decrypt/fetch mocks
      ],
      thresholds: {
        lines: 96,
        functions: 96,
        statements: 96,
        branches: 88,
      },
    },
  },
});
