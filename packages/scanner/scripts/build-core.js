#!/usr/bin/env node
/**
 * Build Core static artifact: dist/core/ with index.html and js/ for static hosting.
 * Sets window.__CORE_ONLY__ = true; script paths are already relative in index.html.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scannerRoot = join(__dirname, '..');
const publicDir = join(scannerRoot, 'public');
const outDir = join(scannerRoot, 'dist', 'core');
const outJs = join(outDir, 'js');

mkdirSync(outJs, { recursive: true });

const html = readFileSync(join(publicDir, 'index.html'), 'utf-8');

const coreHtml = html.replace('<body>', '<body>\n  <script>window.__CORE_ONLY__=true;</script>');

writeFileSync(join(outDir, 'index.html'), coreHtml, 'utf-8');

copyFileSync(join(publicDir, 'js', 'shl-client.js'), join(outJs, 'shl-client.js'));
copyFileSync(join(publicDir, 'js', 'approved-apps.js'), join(outJs, 'approved-apps.js'));
copyFileSync(join(publicDir, 'js', 'sanitize.js'), join(outJs, 'sanitize.js'));

// Copy CSS so dist/core is self-contained
mkdirSync(join(outDir, 'css'), { recursive: true });
copyFileSync(join(publicDir, 'css', 'styles.css'), join(outDir, 'css', 'styles.css'));

console.log('Core build done: dist/core/index.html + dist/core/js/ + dist/core/css/');
