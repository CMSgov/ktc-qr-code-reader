/**
 * Unit tests for auth (hashPassword, verifyPassword, createToken, verifyToken, authMiddleware). No PHI.
 */
import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { hashPassword, verifyPassword, createToken, verifyToken, authMiddleware } from '../auth.js';

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-for-auth-tests';
});

describe('hashPassword and verifyPassword', () => {
  it('hashes and verifies matching password', async () => {
    const plain = 'test-password';
    const hash = await hashPassword(plain);
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe('string');
    const ok = await verifyPassword(plain, hash);
    expect(ok).toBe(true);
  });

  it('verifyPassword returns false for wrong password', async () => {
    const hash = await hashPassword('correct');
    const ok = await verifyPassword('wrong', hash);
    expect(ok).toBe(false);
  });
});

describe('createToken and verifyToken', () => {
  it('creates token and verifyToken returns payload', () => {
    const token = createToken({
      slug: 'my-org',
      role: 'admin',
      orgId: 'org-123',
      timeoutMinutes: 60,
    });
    expect(token).toBeTruthy();
    expect(token).toContain('.');
    const payload = verifyToken(token);
    expect(payload).toBeTruthy();
    expect(payload.slug).toBe('my-org');
    expect(payload.role).toBe('admin');
    expect(payload.orgId).toBe('org-123');
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('verifyToken returns null for missing or invalid token', () => {
    expect(verifyToken(null)).toBe(null);
    expect(verifyToken('')).toBe(null);
    expect(verifyToken('not-two-parts')).toBe(null);
  });

  it('verifyToken returns null for wrong signature', () => {
    const token = createToken({
      slug: 'x',
      role: 'staff',
      orgId: 'id',
      timeoutMinutes: 60,
    });
    const [payloadB64] = token.split('.');
    const badToken = payloadB64 + '.wrongsignature';
    expect(verifyToken(badToken)).toBe(null);
  });

  it('verifyToken returns null for expired token', () => {
    const payload = {
      slug: 'x',
      role: 'staff',
      orgId: 'id',
      exp: Math.floor(Date.now() / 1000) - 60,
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', 'test-secret-for-auth-tests')
      .update(payloadB64)
      .digest('base64url');
    const token = `${payloadB64}.${sig}`;
    expect(verifyToken(token)).toBe(null);
  });
});

describe('authMiddleware', () => {
  it('returns 401 when Authorization header is missing', () => {
    const middleware = authMiddleware('staff');
    const req = { headers: {}, params: {} };
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    const next = () => {};
    middleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required.' });
  });

  it('returns 401 when token is invalid', () => {
    const middleware = authMiddleware('staff');
    const req = { headers: { authorization: 'Bearer invalid-token' }, params: {} };
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    const next = () => {};
    middleware(req, res, next);
    expect(res.statusCode).toBe(401);
  });

  it('calls next when token is valid and role matches', () => {
    const token = createToken({
      slug: 'org1',
      role: 'staff',
      orgId: 'id1',
      timeoutMinutes: 60,
    });
    const middleware = authMiddleware('staff');
    const req = {
      headers: { authorization: `Bearer ${token}` },
      params: { slug: 'org1' },
    };
    let nextCalled = false;
    const next = () => {
      nextCalled = true;
    };
    const res = { status: () => res, json: () => res };
    middleware(req, res, next);
    expect(nextCalled).toBe(true);
    expect(req.org).toBeTruthy();
    expect(req.org.slug).toBe('org1');
  });

  it('returns 403 when slug does not match', () => {
    const token = createToken({
      slug: 'org1',
      role: 'staff',
      orgId: 'id1',
      timeoutMinutes: 60,
    });
    const middleware = authMiddleware('staff');
    const req = {
      headers: { authorization: `Bearer ${token}` },
      params: { slug: 'other-org' },
    };
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    const next = () => {};
    middleware(req, res, next);
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when admin required but token is staff', () => {
    const token = createToken({
      slug: 'org1',
      role: 'staff',
      orgId: 'id1',
      timeoutMinutes: 60,
    });
    const middleware = authMiddleware('admin');
    const req = {
      headers: { authorization: `Bearer ${token}` },
      params: { slug: 'org1' },
    };
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    const next = () => {};
    middleware(req, res, next);
    expect(res.statusCode).toBe(403);
  });
});
