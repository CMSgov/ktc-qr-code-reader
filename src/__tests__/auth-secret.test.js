/**
 * Extra auth branch tests for secret fallback and malformed payload handling.
 */
import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('auth secret fallback and malformed payload branches', () => {
  afterEach(() => {
    delete process.env.SESSION_SECRET;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('generates a random secret and warns when SESSION_SECRET is missing', async () => {
    delete process.env.SESSION_SECRET;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { createToken, verifyToken } = await import('../auth.js');
    const token = createToken({ slug: 'org-a', role: 'staff', orgId: 'org-1', timeoutMinutes: 5 });
    const payload = verifyToken(token);

    expect(payload).toBeTruthy();
    expect(payload.slug).toBe('org-a');
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('returns null when token payload is not valid JSON', async () => {
    process.env.SESSION_SECRET = 'auth-secret-branch-test';
    const { verifyToken } = await import('../auth.js');

    const payloadB64 = Buffer.from('not-json', 'utf-8').toString('base64url');
    const sig = createHmac('sha256', process.env.SESSION_SECRET).update(payloadB64).digest('base64url');
    const token = `${payloadB64}.${sig}`;

    expect(verifyToken(token)).toBe(null);
  });
});
