/**
 * Unit tests for SHL URI parser (uri-parser.js).
 * No PHI; minimal synthetic payloads only.
 */
import { describe, it, expect } from 'vitest';
import { parseShlUri } from '../uri-parser.js';

function makePayload(overrides = {}) {
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) keyBytes[i] = i + 1;
  const keyB64 = Buffer.from(keyBytes).toString('base64url');
  return {
    url: 'https://example.com/shl/v1/manifest',
    key: keyB64,
    ...overrides,
  };
}

function shlUriFromPayload(payload) {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf-8').toString('base64url');
  return `shlink:/${b64}`;
}

describe('parseShlUri', () => {
  it('returns null for empty or non-SHL text', () => {
    expect(parseShlUri('')).toBe(null);
    expect(parseShlUri(null)).toBe(null);
    expect(parseShlUri('https://example.com')).toBe(null);
    expect(parseShlUri('not-shlink:/abc')).toBe(null);
  });

  it('returns null when payload is not valid JSON', () => {
    const text = 'shlink:/not-valid-base64url!!!';
    expect(parseShlUri(text)).toBe(null);
  });

  it('returns null when url or key is missing', () => {
    const noUrl = makePayload({ url: undefined });
    expect(parseShlUri(shlUriFromPayload(noUrl))).toBe(null);
    const noKey = makePayload({ key: undefined });
    expect(parseShlUri(shlUriFromPayload(noKey))).toBe(null);
  });

  it('returns null when key is not 32 bytes', () => {
    const shortKey = makePayload({ key: Buffer.from([1, 2, 3]).toString('base64url') });
    expect(parseShlUri(shlUriFromPayload(shortKey))).toBe(null);
  });

  it('returns parsed payload for valid SHL', () => {
    const payload = makePayload({ flag: 'U', label: 'Test' });
    const text = shlUriFromPayload(payload);
    const result = parseShlUri(text);
    expect(result).toBeTruthy();
    expect(result.url).toBe(payload.url);
    expect(result.key).toBeInstanceOf(Uint8Array);
    expect(result.key.length).toBe(32);
    expect(result.flag).toBe('U');
    expect(result.label).toBe('Test');
  });

  it('throws when link is expired', () => {
    const exp = Math.floor(Date.now() / 1000) - 60; // 1 min ago
    const payload = makePayload({ exp });
    const text = shlUriFromPayload(payload);
    expect(() => parseShlUri(text)).toThrow(/expired/);
  });

  it('accepts link with future expiry', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const payload = makePayload({ exp });
    const text = shlUriFromPayload(payload);
    const result = parseShlUri(text);
    expect(result).toBeTruthy();
    expect(result.exp).toBe(exp);
  });
});
