import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

  // Migrations: add new columns if they don't exist
  const migrations = [
    `ALTER TABLE organizations ADD COLUMN save_format TEXT NOT NULL DEFAULT 'both'`,
    `ALTER TABLE organizations ADD COLUMN onedrive_refresh_token TEXT`,
    `ALTER TABLE organizations ADD COLUMN onedrive_folder_path TEXT`,
    `ALTER TABLE organizations ADD COLUMN box_refresh_token TEXT`,
    `ALTER TABLE organizations ADD COLUMN box_folder_id TEXT`,
  ];

  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* Column already exists */ }
  }
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
    'name', 'storage_type', 'save_format',
    'drive_folder_id', 'drive_refresh_token',
    'onedrive_refresh_token', 'onedrive_folder_path',
    'box_refresh_token', 'box_folder_id',
    'api_url', 'api_headers',
    'email_to',
    'admin_password_hash', 'staff_password_hash',
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

  getDb().prepare(`UPDATE organizations SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}
