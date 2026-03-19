/**
 * Unit tests for crypto (encryptToken, decryptToken, isEncrypted, ensureEncrypted). No PHI.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { encryptToken, decryptToken, isEncrypted, ensureEncrypted } from '../crypto.js';

const ORG_ID = 'test-org-id-123';

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-for-crypto-tests';
});

describe('encryptToken and decryptToken', () => {
  it('round-trip encrypt and decrypt', () => {
    const plain = 'refresh-token-abc';
    const encrypted = encryptToken(plain, ORG_ID);
    expect(encrypted).toBeTruthy();
    expect(encrypted.startsWith('enc:v1:')).toBe(true);
    const decrypted = decryptToken(encrypted, ORG_ID);
    expect(decrypted).toBe(plain);
  });

  it('encryptToken returns null for empty plaintext', () => {
    expect(encryptToken('', ORG_ID)).toBe(null);
    expect(encryptToken(null, ORG_ID)).toBe(null);
  });

  it('decryptToken returns null for empty stored', () => {
    expect(decryptToken('', ORG_ID)).toBe(null);
    expect(decryptToken(null, ORG_ID)).toBe(null);
  });

  it('decryptToken returns plaintext for legacy non-prefix value', () => {
    const plain = 'legacy-token';
    expect(decryptToken(plain, ORG_ID)).toBe(plain);
  });

  it('decryptToken with wrong orgId does not return original', () => {
    const plain = 'secret';
    const encrypted = encryptToken(plain, ORG_ID);
    expect(() => decryptToken(encrypted, 'other-org-id')).toThrow();
  });
});

describe('isEncrypted', () => {
  it('returns true for enc:v1: prefix', () => {
    expect(isEncrypted('enc:v1:abc:def:tag')).toBe(true);
  });

  it('returns false for non-prefix', () => {
    expect(isEncrypted('plain')).toBe(false);
    expect(isEncrypted('')).toBeFalsy();
    expect(isEncrypted(null)).toBeFalsy();
  });
});

describe('ensureEncrypted', () => {
  it('returns already encrypted value as-is', () => {
    const enc = encryptToken('x', ORG_ID);
    expect(ensureEncrypted(enc, ORG_ID)).toBe(enc);
  });

  it('encrypts plaintext', () => {
    const plain = 'plain-token';
    const result = ensureEncrypted(plain, ORG_ID);
    expect(result).toBeTruthy();
    expect(result.startsWith('enc:v1:')).toBe(true);
    expect(decryptToken(result, ORG_ID)).toBe(plain);
  });

  it('returns null for null input', () => {
    expect(ensureEncrypted(null, ORG_ID)).toBe(null);
  });
});
