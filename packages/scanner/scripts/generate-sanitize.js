#!/usr/bin/env node
/**
 * Generate public/js/sanitize.js from scanner-local sanitize source.
 * Run from package root: npm run generate:sanitize
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scannerRoot = join(__dirname, '..');
const srcPath = join(scannerRoot, 'src', 'util', 'sanitize.js');
const outPath = join(scannerRoot, 'public', 'js', 'sanitize.js');

let src = readFileSync(srcPath, 'utf-8');
src = src.replace(/export function /g, 'function ');
src = src.replace(/export \{ .* \};?\s*$/, '');
const content = `/**
 * Generated from util/sanitize.js. Do not edit by hand.
 * Regenerate with: npm run generate:sanitize
 */
(function() {
  'use strict';
${src}
  window.escapeHtml = escapeHtml;
  window.isSafeBase64 = isSafeBase64;
  window.isSafeUrl = isSafeUrl;
})();
`;

writeFileSync(outPath, content, 'utf-8');
console.log('Generated packages/scanner/public/js/sanitize.js');
