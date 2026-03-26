import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

describe('sidecar auth middleware', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.SESSION_SECRET = '12345678901234567890123456789012';
  });

  it('returns 401 when bearer token is missing', async () => {
    const { authMiddleware } = await import('../auth.js');
    const req = { headers: {}, params: {} };
    const status = vi.fn(() => ({ json: vi.fn() }));
    const res = { status };
    const next = vi.fn();

    authMiddleware('staff')(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is invalid', async () => {
    const { authMiddleware } = await import('../auth.js');
    const req = { headers: { authorization: 'Bearer invalid' }, params: {} };
    const status = vi.fn(() => ({ json: vi.fn() }));
    const res = { status };
    const next = vi.fn();

    authMiddleware('staff')(req, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when token slug does not match route slug', async () => {
    const { authMiddleware, createToken } = await import('../auth.js');
    const token = createToken({ slug: 'acme', role: 'staff', orgId: 'org-1' });
    const req = { headers: { authorization: `Bearer ${token}` }, params: { slug: 'beta' } };
    const status = vi.fn(() => ({ json: vi.fn() }));
    const res = { status };
    const next = vi.fn();

    authMiddleware('staff')(req, res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when admin role is required but token role is not admin', async () => {
    const { authMiddleware, createToken } = await import('../auth.js');
    const token = createToken({ slug: 'acme', role: 'staff', orgId: 'org-1' });
    const req = { headers: { authorization: `Bearer ${token}` }, params: { slug: 'acme' } };
    const status = vi.fn(() => ({ json: vi.fn() }));
    const res = { status };
    const next = vi.fn();

    authMiddleware('admin')(req, res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows request and attaches org payload when token is valid', async () => {
    const { authMiddleware, createToken } = await import('../auth.js');
    const token = createToken({ slug: 'acme', role: 'admin', orgId: 'org-1', timeoutMinutes: 10 });
    const req = { headers: { authorization: `Bearer ${token}` }, params: { slug: 'acme' } };
    const res = { status: vi.fn(() => ({ json: vi.fn() })) };
    const next = vi.fn();

    authMiddleware('admin')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.org).toEqual(
      expect.objectContaining({
        slug: 'acme',
        role: 'admin',
        orgId: 'org-1',
      }),
    );
  });
});
