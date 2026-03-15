#!/usr/bin/env node
/**
 * Generate public/js/approved-apps.js from scanner-local data source.
 * Run from package root: npm run generate:approved-apps
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scannerRoot = join(__dirname, '..');
const outPath = join(scannerRoot, 'public', 'js', 'approved-apps.js');

const dataPath = pathToFileURL(join(scannerRoot, 'data', 'approved-apps.js')).href;
const { APPROVED_APPS, KNOWN_SHL_MANIFEST_HOSTS } = await import(dataPath);
const appsJson = JSON.stringify(APPROVED_APPS, null, 2);
const hostsJson = JSON.stringify(KNOWN_SHL_MANIFEST_HOSTS, null, 2);

const content = `/**
 * Generated from data/approved-apps.js. Do not edit by hand.
 * Regenerate with: npm run generate:approved-apps
 */
(function() {
  'use strict';
  window.APPROVED_APPS_CORE = ${appsJson.replace(/\n/g, '\n  ')};
  window.KNOWN_SHL_MANIFEST_HOSTS = window.KNOWN_SHL_MANIFEST_HOSTS || ${hostsJson};
})();
`;

writeFileSync(outPath, content, 'utf-8');
console.log('Generated packages/scanner/public/js/approved-apps.js');
