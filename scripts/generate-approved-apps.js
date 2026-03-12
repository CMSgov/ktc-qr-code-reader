#!/usr/bin/env node
/**
 * Generate public/js/approved-apps.js from data/approved-apps.js (single source of truth).
 * Run: node scripts/generate-approved-apps.js  or  npm run generate:approved-apps
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVED_APPS, KNOWN_SHL_MANIFEST_HOSTS } from '../data/approved-apps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outPath = join(root, 'public', 'js', 'approved-apps.js');

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
console.log('Generated public/js/approved-apps.js');