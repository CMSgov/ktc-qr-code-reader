#!/usr/bin/env node
/**
 * Create a zip of packages/scanner/dist/core/ named killtheclipboard-core-<version>.zip.
 * Run after: npm run build (builds the scanner package).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const version = pkg.version;
const distCore = join(root, 'packages', 'scanner', 'dist', 'core');
const zipName = `killtheclipboard-core-${version}.zip`;

if (!existsSync(distCore)) {
  console.error('packages/scanner/dist/core/ not found. Run npm run build first.');
  process.exit(1);
}

execSync(`cd packages/scanner/dist && zip -rq ../../../${zipName} core`, {
  cwd: root,
  stdio: 'inherit',
});
console.log('Created', zipName);
