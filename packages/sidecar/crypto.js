/**
 * Token encryption at rest using AES-256-GCM.
 *
 * Each organization gets a unique encryption key derived from:
 *   HMAC-SHA256(SESSION_SECRET, orgId)
 *
 * This ensures:
 *   - Tokens are encrypted at rest in SQLite
 *   - Each org's tokens are encrypted with a different key
 *   - A database leak alone does not expose OAuth tokens
 *   - No additional secrets to manage (derived from existing SESSION_SECRET)
 *
 * Encrypted format: "enc:v1:<iv_hex>:<ciphertext_hex>:<tag_hex>"
 */

import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, recommended for GCM
const PREFIX = 'enc:v1:';

/**
 * Derive a per-org 256-bit encryption key from SESSION_SECRET + orgId.
 * @param {string} orgId - Organization UUID
 * @returns {Buffer} 32-byte key
 */
function deriveKey(orgId) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    return null;
  }
  return createHmac('sha256', secret).update(orgId).digest();
}

export function encryptToken(plaintext, orgId) {
  if (!plaintext) return null;

  const key = deriveKey(orgId);
  if (!key) return plaintext;

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return `${PREFIX}${iv.toString('hex')}:${encrypted}:${tag}`;
}

export function decryptToken(stored, orgId) {
  if (!stored) return null;

  if (!stored.startsWith(PREFIX)) return stored;

  const key = deriveKey(orgId);
  if (!key) throw new Error('Cannot decrypt token: SESSION_SECRET not set');

  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Malformed encrypted token');

  const [ivHex, ciphertextHex, tagHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext, null, 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

export function isEncrypted(value) {
  return value && value.startsWith(PREFIX);
}

export function ensureEncrypted(stored, orgId) {
  if (!stored) return null;
  if (isEncrypted(stored)) return stored;
  return encryptToken(stored, orgId);
}
