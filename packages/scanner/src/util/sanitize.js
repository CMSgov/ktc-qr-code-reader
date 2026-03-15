/**
 * HTML and URL sanitization helpers for scanner/browser rendering.
 */

export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Validates safe base64 for data: URLs (prevents attribute injection in <embed src="data:...">). */
export function isSafeBase64(str) {
  return typeof str === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(str);
}

/** Validates https: only (prevents javascript: and data: in href/src). */
export function isSafeUrl(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
