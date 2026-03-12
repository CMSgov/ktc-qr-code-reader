#!/usr/bin/env node
/**
 * Build Core static artifact: dist/core/ with index.html and js/ for CDN/static hosting.
 * Sets window.__CORE_ONLY__ = true and uses relative paths so the app works from any base path.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const publicDir = join(root, 'public');
const outDir = join(root, 'dist', 'core');
const outJs = join(outDir, 'js');

mkdirSync(outJs, { recursive: true });

const html = readFileSync(join(publicDir, 'scanner.html'), 'utf-8');

const coreHtml = html
  .replace('<body>', '<body>\n  <script>window.__CORE_ONLY__=true;</script>')
  .replace(/src="\/js\//g, 'src="js/');

writeFileSync(join(outDir, 'index.html'), coreHtml, 'utf-8');

copyFileSync(join(publicDir, 'js', 'shl-client.js'), join(outJs, 'shl-client.js'));
copyFileSync(join(publicDir, 'js', 'approved-apps.js'), join(outJs, 'approved-apps.js'));
copyFileSync(join(publicDir, 'js', 'sanitize.js'), join(outJs, 'sanitize.js'));

console.log('Core build done: dist/core/index.html + dist/core/js/');
