#!/usr/bin/env node
/**
 * Generate public/js/sanitize.js from src/util/sanitize.js (single source of truth).
 * Run: node scripts/generate-sanitize.js  or  npm run generate:sanitize
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const srcPath = join(root, 'src', 'util', 'sanitize.js');
const outPath = join(root, 'public', 'js', 'sanitize.js');

let src = readFileSync(srcPath, 'utf-8');
// Remove export keyword and export list so the file is valid as a classic script body
src = src.replace(/export function /g, 'function ');
src = src.replace(/export \{ .* \};?\s*$/, '');
const content = `/**
 * Generated from src/util/sanitize.js. Do not edit by hand.
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
console.log('Generated public/js/sanitize.js');