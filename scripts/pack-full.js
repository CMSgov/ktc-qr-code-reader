#!/usr/bin/env node
/**
 * Create a zip of the full app (Tier 2+) for server deployment: killtheclipboard-full-<version>.zip.
 * Includes server, public/, src/, data/, bin/, scripts/, package.json, package-lock.json, README.md.
 * Excludes node_modules/, .git/, dist/, test/, .env*, coverage/, *.db.
 * Consumers run: unzip, then npm ci && npm start with required env vars.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const version = pkg.version;
const zipName = `killtheclipboard-full-${version}.zip`;

// Paths to include (from repo root). Zip with -r; exclusions via -x.
const includes = [
  'server.js',
  'public',
  'src',
  'data',
  'bin',
  'scripts',
  'package.json',
  'package-lock.json',
  'README.md',
  '.npmrc',
].filter((p) => existsSync(join(root, p)));

const excludes = [
  'node_modules/*',
  'node_modules/**',
  '.git/*',
  '.git/**',
  'dist/*',
  'dist/**',
  'test/*',
  'test/**',
  '*.db',
  'coverage/*',
  'coverage/**',
  '.env*',
  '*.zip',
  '.DS_Store',
];

const xArgs = excludes.flatMap((x) => ['-x', x]);
const result = spawnSync('zip', ['-rq', zipName, ...includes, ...xArgs], {
  cwd: root,
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('Created', zipName);
