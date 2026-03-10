/**
 * Base64url encoding/decoding (RFC 4648 §5).
 */

export function decode(str) {
  return new Uint8Array(Buffer.from(str, 'base64url'));
}

export function decodeToString(str) {
  return Buffer.from(str, 'base64url').toString('utf-8');
}

export function encode(bytes) {
  return Buffer.from(bytes).toString('base64url');
}
