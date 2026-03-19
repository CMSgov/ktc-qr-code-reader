/**
 * Fetch the SHL manifest and retrieve file entries.
 *
 * Standard path (no U flag): POST to manifest URL with recipient + optional passcode.
 * Direct path (U flag): GET request, response is a single JWE file.
 */
export async function fetchManifest(shlPayload, config = {}) {
  const { recipient = 'Killtheclipboard', passcode = null } = config;
  const hasPasscode = shlPayload.flag.includes('P');
  const isDirect = shlPayload.flag.includes('U');

  if (hasPasscode && !passcode) {
    throw new Error('This SHL requires a passcode. Use --passcode <code>');
  }

  if (isDirect) {
    // U flag: single encrypted file via GET
    const url = new URL(shlPayload.url);
    url.searchParams.set('recipient', recipient);
    const resp = await fetch(url.toString());

    if (!resp.ok) {
      throw new Error(`SHL manifest fetch failed: ${resp.status} ${resp.statusText}`);
    }

    const jwe = await resp.text();
    return {
      files: [{ contentType: 'application/jose', embedded: jwe }],
    };
  }

  // Standard path: POST to manifest URL
  const body = { recipient };
  if (hasPasscode && passcode) {
    body.passcode = passcode;
  }

  const resp = await fetch(shlPayload.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (resp.status === 401) {
    const errBody = await resp.json().catch(() => ({}));
    const remaining = errBody.remainingAttempts;
    throw new Error(
      `Invalid passcode.${remaining != null ? ` ${remaining} attempts remaining.` : ''}`,
    );
  }

  if (resp.status === 404) {
    throw new Error('This SHL is no longer active (deactivated or expired).');
  }

  if (resp.status === 429) {
    const retryAfter = resp.headers.get('Retry-After');
    throw new Error(
      `Rate limited by SHL server.${retryAfter ? ` Retry after ${retryAfter}s.` : ''}`,
    );
  }

  if (!resp.ok) {
    throw new Error(`SHL manifest fetch failed: ${resp.status} ${resp.statusText}`);
  }

  return resp.json();
}

/**
 * Retrieve a file from a manifest location URL.
 * Returns the raw response body as text (expected to be JWE compact serialization).
 */
export async function fetchFile(locationUrl) {
  const resp = await fetch(locationUrl);
  if (!resp.ok) {
    throw new Error(`Failed to fetch SHL file: ${resp.status} ${resp.statusText}`);
  }
  return resp.text();
}
