import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { encryptToken, decryptToken, isEncrypted, ensureEncrypted } from './crypto.js';

let db;

/**
 * Initialize the SQLite database. Call once at server startup.
 */
export function initDb() {
  if (db) return db;

  const dbPath = process.env.DATABASE_PATH || './data/ktc.db';

  // Ensure the directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
}

/**
 * Get the initialized database instance.
 */
export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

/**
 * Run schema migrations.
 */
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      admin_password_hash TEXT NOT NULL,
      staff_password_hash TEXT NOT NULL,
      storage_type TEXT NOT NULL DEFAULT 'download',
      save_format TEXT NOT NULL DEFAULT 'both',
      drive_folder_id TEXT,
      drive_refresh_token TEXT,
      api_url TEXT,
      api_headers TEXT,
      email_to TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_orgs_slug ON organizations(slug);
  `);

  // Approval requests table (for Gmail/Outlook pending verification)
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_slug TEXT NOT NULL,
      org_name TEXT NOT NULL,
      email TEXT NOT NULL,
      service TEXT NOT NULL DEFAULT 'gmail',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT
    );
  `);

  // Audit log table — records scan routing events (no PHI content, only metadata)
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_slug TEXT NOT NULL,
      event_type TEXT NOT NULL,
      storage_type TEXT,
      fhir_bundle_count INTEGER DEFAULT 0,
      pdf_count INTEGER DEFAULT 0,
      success INTEGER DEFAULT 1,
      error_message TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_slug);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  `);

  // Migrations: add new columns if they don't exist
  const migrations = [
    `ALTER TABLE organizations ADD COLUMN save_format TEXT NOT NULL DEFAULT 'both'`,
    `ALTER TABLE organizations ADD COLUMN onedrive_refresh_token TEXT`,
    `ALTER TABLE organizations ADD COLUMN onedrive_folder_path TEXT`,
    `ALTER TABLE organizations ADD COLUMN box_refresh_token TEXT`,
    `ALTER TABLE organizations ADD COLUMN box_folder_id TEXT`,
    `ALTER TABLE organizations ADD COLUMN gmail_refresh_token TEXT`,
    `ALTER TABLE organizations ADD COLUMN gmail_email TEXT`,
    `ALTER TABLE organizations ADD COLUMN outlook_refresh_token TEXT`,
    `ALTER TABLE organizations ADD COLUMN outlook_email TEXT`,
    `ALTER TABLE organizations ADD COLUMN require_app_validation INT DEFAULT 0`,
    `ALTER TABLE organizations ADD COLUMN session_timeout_minutes INT DEFAULT 720`,
  ];

  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
      /* Column already exists */
    }
  }

  // Encrypt any plaintext OAuth tokens at rest
  migrateTokenEncryption(db);
}

/**
 * Token column names that should be encrypted at rest.
 */
const TOKEN_COLUMNS = [
  'drive_refresh_token',
  'onedrive_refresh_token',
  'box_refresh_token',
  'gmail_refresh_token',
  'outlook_refresh_token',
];

/**
 * Migrate existing plaintext OAuth refresh tokens to encrypted form.
 * Runs on every startup — idempotent (skips already-encrypted tokens).
 */
function migrateTokenEncryption(db) {
  if (!process.env.SESSION_SECRET) {
    // Can't encrypt without SESSION_SECRET — skip silently (warning logged by auth.js)
    return;
  }

  const orgs = db.prepare('SELECT id, ' + TOKEN_COLUMNS.join(', ') + ' FROM organizations').all();
  let migrated = 0;

  for (const org of orgs) {
    const updates = {};
    for (const col of TOKEN_COLUMNS) {
      const value = org[col];
      if (value && !isEncrypted(value)) {
        updates[col] = ensureEncrypted(value, org.id);
        migrated++;
      }
    }

    if (Object.keys(updates).length > 0) {
      const sets = Object.keys(updates).map((k) => `${k} = ?`);
      const vals = Object.values(updates);
      db.prepare(`UPDATE organizations SET ${sets.join(', ')} WHERE id = ?`).run(...vals, org.id);
    }
  }

  if (migrated > 0) {
    console.log(`[Security] Encrypted ${migrated} plaintext OAuth token(s) at rest.`);
  }
}

// ── Token Encryption Helpers ─────────────────────────────────────

/**
 * Get a decrypted OAuth refresh token from an org record.
 * @param {object} org - Organization row from database
 * @param {string} column - Column name (e.g. 'drive_refresh_token')
 * @returns {string|null} Decrypted plaintext token
 */
export function getDecryptedToken(org, column) {
  const value = org[column];
  if (!value) return null;
  return decryptToken(value, org.id);
}

/**
 * Prepare a token value for storage (encrypts it).
 * @param {string} plaintext - The plaintext token
 * @param {string} orgId - Organization UUID
 * @returns {string|null} Encrypted token for storage
 */
export function prepareTokenForStorage(plaintext, orgId) {
  if (!plaintext) return null;
  return encryptToken(plaintext, orgId);
}

// ── CRUD Operations ──────────────────────────────────────────────

/**
 * Create a new organization.
 */
export function createOrg({ id, slug, name, adminPasswordHash, staffPasswordHash }) {
  const stmt = getDb().prepare(`
    INSERT INTO organizations (id, slug, name, admin_password_hash, staff_password_hash)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(id, slug, name, adminPasswordHash, staffPasswordHash);
  return getOrgBySlug(slug);
}

/**
 * Find an organization by its URL slug.
 */
export function getOrgBySlug(slug) {
  return getDb().prepare('SELECT * FROM organizations WHERE slug = ?').get(slug) || null;
}

/**
 * Find an organization by its UUID.
 */
export function getOrgById(id) {
  return getDb().prepare('SELECT * FROM organizations WHERE id = ?').get(id) || null;
}

/**
 * Check if a slug is already taken.
 */
export function slugExists(slug) {
  const row = getDb().prepare('SELECT 1 FROM organizations WHERE slug = ?').get(slug);
  return !!row;
}

/**
 * Update organization settings. Only updates the fields present in `fields`.
 */
export function updateOrgSettings(id, fields) {
  const allowed = [
    'name',
    'storage_type',
    'save_format',
    'drive_folder_id',
    'drive_refresh_token',
    'onedrive_refresh_token',
    'onedrive_folder_path',
    'box_refresh_token',
    'box_folder_id',
    'gmail_refresh_token',
    'gmail_email',
    'outlook_refresh_token',
    'outlook_email',
    'api_url',
    'api_headers',
    'email_to',
    'admin_password_hash',
    'staff_password_hash',
    'require_app_validation',
    'session_timeout_minutes',
  ];

  const sets = [];
  const values = [];

  for (const [key, value] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      sets.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");
  values.push(id);

  getDb()
    .prepare(`UPDATE organizations SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);
}

// ── Super Admin Operations ───────────────────────────────────────

/**
 * List all organizations (for super admin dashboard).
 */
export function listAllOrgs() {
  return getDb()
    .prepare(`
    SELECT id, slug, name, storage_type, created_at, updated_at,
           gmail_email, outlook_email,
           CASE WHEN drive_refresh_token IS NOT NULL THEN 1 ELSE 0 END as has_drive,
           CASE WHEN onedrive_refresh_token IS NOT NULL THEN 1 ELSE 0 END as has_onedrive,
           CASE WHEN box_refresh_token IS NOT NULL THEN 1 ELSE 0 END as has_box,
           CASE WHEN gmail_refresh_token IS NOT NULL THEN 1 ELSE 0 END as has_gmail,
           CASE WHEN outlook_refresh_token IS NOT NULL THEN 1 ELSE 0 END as has_outlook
    FROM organizations ORDER BY created_at DESC
  `)
    .all();
}

/**
 * Delete an organization by ID.
 */
export function deleteOrgById(id) {
  const org = getDb().prepare('SELECT slug FROM organizations WHERE id = ?').get(id);
  if (org) {
    getDb().prepare('DELETE FROM approval_requests WHERE org_slug = ?').run(org.slug);
  }
  getDb().prepare('DELETE FROM organizations WHERE id = ?').run(id);
}

/**
 * Count total organizations.
 */
export function countOrgs() {
  return getDb().prepare('SELECT COUNT(*) as count FROM organizations').get().count;
}

// ── Approval Requests ──────────────────────────────────────────

/**
 * Create a new approval request for Gmail/Outlook access.
 */
export function createApprovalRequest({ orgSlug, orgName, email, service }) {
  // Check if a pending request already exists for this email+service
  const existing = getDb()
    .prepare('SELECT 1 FROM approval_requests WHERE email = ? AND service = ? AND status = ?')
    .get(email, service, 'pending');
  if (existing) return { alreadyExists: true };

  getDb()
    .prepare(`
    INSERT INTO approval_requests (org_slug, org_name, email, service)
    VALUES (?, ?, ?, ?)
  `)
    .run(orgSlug, orgName, email, service);
  return { alreadyExists: false };
}

/**
 * List all approval requests (for admin dashboard).
 */
export function listApprovalRequests(status) {
  if (status) {
    return getDb()
      .prepare('SELECT * FROM approval_requests WHERE status = ? ORDER BY created_at DESC')
      .all(status);
  }
  return getDb().prepare('SELECT * FROM approval_requests ORDER BY created_at DESC').all();
}

/**
 * Update an approval request status.
 */
export function updateApprovalRequest(id, status) {
  getDb()
    .prepare("UPDATE approval_requests SET status = ?, reviewed_at = datetime('now') WHERE id = ?")
    .run(status, id);
}

// ── Audit Log ─────────────────────────────────────────────

/**
 * Record a scan/route event in the audit log.
 * Stores only metadata — NO PHI content (no patient names, no FHIR data, no PDFs).
 */
export function logAuditEvent({
  orgSlug,
  eventType,
  storageType = null,
  fhirBundleCount = 0,
  pdfCount = 0,
  success = true,
  errorMessage = null,
  ipAddress = null,
  userAgent = null,
}) {
  try {
    getDb()
      .prepare(`
      INSERT INTO audit_log (org_slug, event_type, storage_type, fhir_bundle_count, pdf_count, success, error_message, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        orgSlug,
        eventType,
        storageType,
        fhirBundleCount,
        pdfCount,
        success ? 1 : 0,
        errorMessage,
        ipAddress,
        userAgent,
      );
  } catch (err) {
    // Audit logging should never break the main flow
    console.error('[Audit] Failed to log event:', err.message);
  }
}

/**
 * List audit log entries for an organization (for admin dashboard).
 */
export function listAuditLog(orgSlug, limit = 100) {
  return getDb()
    .prepare('SELECT * FROM audit_log WHERE org_slug = ? ORDER BY created_at DESC LIMIT ?')
    .all(orgSlug, limit);
}

/**
 * List all audit log entries (for super admin dashboard).
 */
export function listAllAuditLog(limit = 500) {
  return getDb().prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
}
