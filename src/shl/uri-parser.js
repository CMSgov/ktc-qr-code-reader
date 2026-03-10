import { decode, decodeToString } from '../util/base64url.js';

/**
 * Extract and parse a SMART Health Link payload from a string.
 * Handles both raw "shlink:/..." and viewer URLs like "https://...#shlink:/..."
 *
 * Returns parsed SHL payload or null if string isn't a valid SHL.
 */
export function parseShlUri(text) {
  if (!text) return null;

  // Extract the shlink:/ portion from the text
  const match = text.match(/shlink:\/([A-Za-z0-9_-]+)/);
  if (!match) return null;

  const payloadB64 = match[1];

  let payload;
  try {
    payload = JSON.parse(decodeToString(payloadB64));
  } catch {
    return null;
  }

  // Validate required fields
  if (!payload.url || !payload.key) return null;

  // Decode the encryption key (32 bytes, base64url-encoded to 43 chars)
  let keyBytes;
  try {
    keyBytes = decode(payload.key);
    if (keyBytes.length !== 32) return null;
  } catch {
    return null;
  }

  // Check expiration
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error(`SHL link expired on ${new Date(payload.exp * 1000).toISOString()}`);
  }

  return {
    url: payload.url,
    key: keyBytes,
    keyB64: payload.key,
    flag: payload.flag || '',
    label: payload.label || null,
    exp: payload.exp || null,
    v: payload.v || 1,
  };
}
