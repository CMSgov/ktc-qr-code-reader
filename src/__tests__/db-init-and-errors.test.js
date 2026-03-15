/**
 * Branch tests for db init/getDb behavior and audit-log error safety.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  delete process.env.DATABASE_PATH;
  delete process.env.SESSION_SECRET;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('db module init/getDb branches', () => {
  it('throws when getDb is called before initDb', async () => {
    const dbModule = await import('../db.js');
    expect(() => dbModule.getDb()).toThrow('Database not initialized');
  });

  it('returns same instance when initDb is called twice', async () => {
    process.env.DATABASE_PATH = ':memory:';
    process.env.SESSION_SECRET = 'db-init-secret';
    const dbModule = await import('../db.js');
    const first = dbModule.initDb();
    const second = dbModule.initDb();
    expect(second).toBe(first);
  });

  it('initializes even without SESSION_SECRET (token-migration skip path)', async () => {
    process.env.DATABASE_PATH = ':memory:';
    delete process.env.SESSION_SECRET;
    const dbModule = await import('../db.js');
    const db = dbModule.initDb();
    expect(db).toBeTruthy();
  });
});

describe('logAuditEvent failure branch', () => {
  it('swallows DB errors and logs them', async () => {
    process.env.DATABASE_PATH = ':memory:';
    process.env.SESSION_SECRET = 'db-audit-secret';
    const dbModule = await import('../db.js');
    dbModule.initDb();

    const db = dbModule.getDb();
    const prepSpy = vi.spyOn(db, 'prepare').mockImplementation(() => {
      throw new Error('forced audit failure');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      dbModule.logAuditEvent({
        orgSlug: 'org-x',
        eventType: 'scan_route',
      }),
    ).not.toThrow();

    expect(prepSpy).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith('[Audit] Failed to log event:', 'forced audit failure');
  });
});
