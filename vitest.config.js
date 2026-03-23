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
      include: [
        'src/**/*.js',
        'data/**/*.js',
        'packages/proxy/**/*.js',
        'packages/sidecar/**/*.js',
      ],
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
        // Sidecar connector modules require live third-party OAuth/API integration.
        'packages/sidecar/connectors/**/*.js',
        // Config and token/database internals are covered in targeted package tests.
        'packages/proxy/lib/**/*.js',
        'packages/sidecar/lib/**/*.js',
        'packages/sidecar/config.js',
        'packages/sidecar/crypto.js',
        'packages/sidecar/db.js',
      ],
      thresholds: {
        // Global threshold now covers scanner + server packages together.
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 70,
        // Keep strict thresholds for core scanner and data paths.
        'src/**/*.js': {
          lines: 96,
          functions: 96,
          statements: 96,
          branches: 88,
        },
        'data/**/*.js': {
          lines: 96,
          functions: 96,
          statements: 96,
          branches: 88,
        },
        // Server packages are expanding coverage incrementally in PR6.
        'packages/proxy/**/*.js': {
          lines: 55,
          functions: 50,
          statements: 55,
          branches: 45,
        },
        'packages/sidecar/**/*.js': {
          lines: 40,
          functions: 10,
          statements: 40,
          branches: 40,
        },
      },
    },
  },
});
