/**
 * Unit tests for db (in-memory SQLite). No PHI.
 * Sets DATABASE_PATH=:memory: and SESSION_SECRET before loading db module.
 */
import { describe, it, expect, beforeAll } from 'vitest';

let dbModule;

beforeAll(async () => {
  process.env.DATABASE_PATH = ':memory:';
  process.env.SESSION_SECRET = 'test-db-secret';
  dbModule = await import('../db.js');
  dbModule.initDb();
});

describe('createOrg, getOrgBySlug, getOrgById, slugExists', () => {
  it('creates org and finds by slug and id', () => {
    const org = dbModule.createOrg({
      id: 'org-create-1',
      slug: 'test-org-slug',
      name: 'Test Org',
      adminPasswordHash: 'admin-hash',
      staffPasswordHash: 'staff-hash',
    });
    expect(org).toBeTruthy();
    expect(org.slug).toBe('test-org-slug');
    expect(org.name).toBe('Test Org');

    const bySlug = dbModule.getOrgBySlug('test-org-slug');
    expect(bySlug.id).toBe('org-create-1');
    const byId = dbModule.getOrgById('org-create-1');
    expect(byId.slug).toBe('test-org-slug');

    expect(dbModule.slugExists('test-org-slug')).toBe(true);
    expect(dbModule.slugExists('nonexistent')).toBe(false);
  });
});

describe('updateOrgSettings', () => {
  it('updates org fields', () => {
    dbModule.createOrg({
      id: 'org-update-1',
      slug: 'update-org',
      name: 'Original',
      adminPasswordHash: 'a',
      staffPasswordHash: 's',
    });
    dbModule.updateOrgSettings('org-update-1', { name: 'Updated Name', storage_type: 'drive' });
    const org = dbModule.getOrgById('org-update-1');
    expect(org.name).toBe('Updated Name');
    expect(org.storage_type).toBe('drive');
  });
});

describe('listAllOrgs, countOrgs, deleteOrgById', () => {
  it('lists and counts orgs, then deletes', () => {
    const before = dbModule.countOrgs();
    dbModule.createOrg({
      id: 'org-list-1',
      slug: 'list-org',
      name: 'List Org',
      adminPasswordHash: 'a',
      staffPasswordHash: 's',
    });
    expect(dbModule.countOrgs()).toBe(before + 1);

    const list = dbModule.listAllOrgs();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.some((o) => o.slug === 'list-org')).toBe(true);

    dbModule.deleteOrgById('org-list-1');
    expect(dbModule.getOrgById('org-list-1')).toBe(null);
    expect(dbModule.countOrgs()).toBe(before);
  });
});

describe('logAuditEvent and listAuditLog', () => {
  it('logs event and lists by org slug', () => {
    dbModule.createOrg({
      id: 'org-audit-1',
      slug: 'audit-org',
      name: 'Audit Org',
      adminPasswordHash: 'a',
      staffPasswordHash: 's',
    });
    dbModule.logAuditEvent({
      orgSlug: 'audit-org',
      eventType: 'scan',
      storageType: 'file',
      fhirBundleCount: 1,
      pdfCount: 0,
      success: true,
    });
    const entries = dbModule.listAuditLog('audit-org', 10);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].event_type).toBe('scan');
    expect(entries[0].org_slug).toBe('audit-org');
  });
});

describe('prepareTokenForStorage and getDecryptedToken', () => {
  it('encrypts token for storage and decrypts from org', () => {
    const orgId = 'org-token-1';
    dbModule.createOrg({
      id: orgId,
      slug: 'token-org',
      name: 'Token Org',
      adminPasswordHash: 'a',
      staffPasswordHash: 's',
    });
    const plaintext = 'refresh-token-secret';
    const encrypted = dbModule.prepareTokenForStorage(plaintext, orgId);
    expect(encrypted).toBeTruthy();
    expect(encrypted.startsWith('enc:v1:')).toBe(true);

    dbModule.updateOrgSettings(orgId, { drive_refresh_token: encrypted });
    const org = dbModule.getOrgById(orgId);
    const decrypted = dbModule.getDecryptedToken(org, 'drive_refresh_token');
    expect(decrypted).toBe(plaintext);
  });

  it('getDecryptedToken returns null for missing token', () => {
    dbModule.createOrg({
      id: 'org-no-token',
      slug: 'no-token-org',
      name: 'No Token Org',
      adminPasswordHash: 'a',
      staffPasswordHash: 's',
    });
    const org = dbModule.getOrgBySlug('no-token-org');
    expect(dbModule.getDecryptedToken(org, 'drive_refresh_token')).toBe(null);
  });

  it('prepareTokenForStorage returns null for empty plaintext', () => {
    expect(dbModule.prepareTokenForStorage('', 'org-any')).toBe(null);
    expect(dbModule.prepareTokenForStorage(null, 'org-any')).toBe(null);
  });
});

describe('approval request workflows', () => {
  it('creates request, blocks duplicate pending, updates status, and lists', () => {
    const first = dbModule.createApprovalRequest({
      orgSlug: 'approval-org',
      orgName: 'Approval Org',
      email: 'ops@example.org',
      service: 'gmail',
    });
    expect(first).toEqual({ alreadyExists: false });

    const duplicate = dbModule.createApprovalRequest({
      orgSlug: 'approval-org',
      orgName: 'Approval Org',
      email: 'ops@example.org',
      service: 'gmail',
    });
    expect(duplicate).toEqual({ alreadyExists: true });

    const pending = dbModule.listApprovalRequests('pending');
    const req = pending.find((r) => r.email === 'ops@example.org' && r.service === 'gmail');
    expect(req).toBeTruthy();

    dbModule.updateApprovalRequest(req.id, 'approved');
    const approved = dbModule.listApprovalRequests('approved');
    expect(approved.some((r) => r.id === req.id && r.reviewed_at)).toBe(true);

    const all = dbModule.listApprovalRequests();
    expect(all.length).toBeGreaterThanOrEqual(1);
  });
});

describe('updateOrgSettings allowlist and no-op branches', () => {
  it('ignores unknown fields and leaves row unchanged', () => {
    dbModule.createOrg({
      id: 'org-update-allowlist',
      slug: 'update-allowlist',
      name: 'Allowlist Org',
      adminPasswordHash: 'a',
      staffPasswordHash: 's',
    });
    const before = dbModule.getOrgById('org-update-allowlist');
    dbModule.updateOrgSettings('org-update-allowlist', { not_allowed: 'x', also_bad: 123 });
    const after = dbModule.getOrgById('org-update-allowlist');
    expect(after.name).toBe(before.name);
    expect(after.storage_type).toBe(before.storage_type);
  });
});

describe('deleteOrgById and audit helpers', () => {
  it('deletes org even when org does not exist', () => {
    expect(() => dbModule.deleteOrgById('org-that-does-not-exist')).not.toThrow();
  });

  it('lists all audit log entries and honors default/explicit limits', () => {
    dbModule.logAuditEvent({ orgSlug: 'audit-org', eventType: 'scan_route' });
    const limited = dbModule.listAllAuditLog(1);
    expect(limited.length).toBeLessThanOrEqual(1);
    const defaults = dbModule.listAllAuditLog();
    expect(Array.isArray(defaults)).toBe(true);
  });
});
