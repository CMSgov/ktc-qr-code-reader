import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { encryptToken, decryptToken, isEncrypted, ensureEncrypted } from './crypto.js';
import { logger } from './lib/logger.js';

let db;

export function initDb() {
  if (db) return db;

  const dbPath = process.env.DATABASE_PATH || './data/ktc.db';
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

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

  migrateTokenEncryption(db);
}

const TOKEN_COLUMNS = [
  'drive_refresh_token',
  'onedrive_refresh_token',
  'box_refresh_token',
  'gmail_refresh_token',
  'outlook_refresh_token',
];

function migrateTokenEncryption(db) {
  if (!process.env.SESSION_SECRET) return;

  const orgs = db.prepare('SELECT id, ' + TOKEN_COLUMNS.join(', ') + ' FROM organizations').all();
  for (const org of orgs) {
    const updates = {};
    for (const col of TOKEN_COLUMNS) {
      const value = org[col];
      if (value && !isEncrypted(value)) {
        updates[col] = ensureEncrypted(value, org.id);
      }
    }
    if (Object.keys(updates).length > 0) {
      const sets = Object.keys(updates).map((k) => `${k} = ?`);
      const vals = Object.values(updates);
      db.prepare(`UPDATE organizations SET ${sets.join(', ')} WHERE id = ?`).run(...vals, org.id);
    }
  }
}

export function getDecryptedToken(org, column) {
  const value = org[column];
  if (!value) return null;
  return decryptToken(value, org.id);
}

export function prepareTokenForStorage(plaintext, orgId) {
  if (!plaintext) return null;
  return encryptToken(plaintext, orgId);
}

export function getOrgBySlug(slug) {
  return getDb().prepare('SELECT * FROM organizations WHERE slug = ?').get(slug) || null;
}

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
    logger.error({ err }, 'failed to log audit event');
  }
}
