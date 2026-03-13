/**
 * Unit tests for approved-app list lookup (Tier 1 app verification).
 * Single source of truth: approved-apps.js; client file is generated from it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVED_APPS } from '../approved-apps.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function findApprovedApp(appId) {
  return APPROVED_APPS.find((a) => a.appId === appId);
}

describe('approved-app list', () => {
  it('finds app by appId', () => {
    const app = findApprovedApp('apple');
    expect(app).toBeTruthy();
    expect(app.name).toBe('Apple');
    expect(app.tier).toBe('early-adopter');
  });

  it('returns undefined for unknown appId', () => {
    expect(findApprovedApp('unknown-app')).toBeUndefined();
    expect(findApprovedApp('')).toBeUndefined();
  });

  it('source has expected count (12 early-adopter + 71 pledgee)', () => {
    expect(APPROVED_APPS.length).toBe(83);
  });

  it('generated client file matches source count and structure', () => {
    const clientScript = readFileSync(
      join(__dirname, '..', '..', 'public', 'js', 'approved-apps.js'),
      'utf-8'
    );
    expect(clientScript).toContain('APPROVED_APPS_CORE');
    expect(clientScript).toContain('KNOWN_SHL_MANIFEST_HOSTS');
    const count = (clientScript.match(/"appId":/g) || []).length;
    expect(count).toBe(APPROVED_APPS.length);
  });
});
