/**
 * Client-side SHL processing pipeline.
 *
 * Runs entirely in the browser — the server never sees decrypted PHI.
 * Uses jose (browser build) for JWE decryption and pako for DEFLATE decompression.
 *
 * Flow:
 *   QR text → parseShlUri() → fetchManifest() → extractHealthData() → results
 *
 * The server is only involved as a CORS proxy for fetching encrypted manifests
 * from SHL servers that don't set CORS headers. The decryption key never
 * leaves the browser.
 */

// ─── Loaded externally via <script> tags ───
// jose: window.jose (from https://unpkg.com/jose@4/dist/browser/index.js)
// pako: window.pako (from https://unpkg.com/pako@2/dist/pako.min.js)

// ════════════════════════════════════════════════════════
//  Base64url helpers (browser-native, no Buffer needed)
// ════════════════════════════════════════════════════════

function base64urlDecode(str) {
  // Convert base64url to standard base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding
  while (base64.length % 4 !== 0) base64 += '=';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64urlDecodeToString(str) {
  const bytes = base64urlDecode(str);
  return new TextDecoder().decode(bytes);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}


// ════════════════════════════════════════════════════════
//  SHL URI Parser
// ════════════════════════════════════════════════════════

function parseShlUri(text) {
  if (!text) return null;

  const match = text.match(/shlink:\/([A-Za-z0-9_-]+)/);
  if (!match) return null;

  const payloadB64 = match[1];

  let payload;
  try {
    payload = JSON.parse(base64urlDecodeToString(payloadB64));
  } catch {
    return null;
  }

  if (!payload.url || !payload.key) return null;

  let keyBytes;
  try {
    keyBytes = base64urlDecode(payload.key);
    if (keyBytes.length !== 32) return null;
  } catch {
    return null;
  }

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


// ════════════════════════════════════════════════════════
//  CORS Proxy — fetch via server (encrypted only)
// ════════════════════════════════════════════════════════

/**
 * Fetch a URL through the server's CORS proxy.
 * The proxy only ever sees encrypted JWE blobs — never decrypted PHI.
 */
async function proxyFetch(proxyBaseUrl, token, { url, method = 'GET', body = null, headers = {} }) {
  const resp = await fetch(proxyBaseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ url, method, body, headers }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: 'Proxy request failed' }));
    throw new Error(err.error || `Proxy fetch failed: ${resp.status}`);
  }

  return resp.json();
}


// ════════════════════════════════════════════════════════
//  Manifest Fetcher (via CORS proxy)
// ════════════════════════════════════════════════════════

async function fetchManifestClient(shlPayload, proxyBaseUrl, token, config = {}) {
  const { recipient = 'Killtheclipboard', passcode = null } = config;
  const hasPasscode = shlPayload.flag.includes('P');
  const isDirect = shlPayload.flag.includes('U');

  if (hasPasscode && !passcode) {
    throw new Error('This SHL requires a passcode.');
  }

  if (isDirect) {
    const url = new URL(shlPayload.url);
    url.searchParams.set('recipient', recipient);

    const result = await proxyFetch(proxyBaseUrl, token, {
      url: url.toString(),
      method: 'GET',
    });

    return {
      files: [{ contentType: 'application/jose', embedded: result.body }],
    };
  }

  const postBody = { recipient };
  if (hasPasscode && passcode) {
    postBody.passcode = passcode;
  }

  const result = await proxyFetch(proxyBaseUrl, token, {
    url: shlPayload.url,
    method: 'POST',
    body: postBody,
    headers: { 'Content-Type': 'application/json' },
  });

  // Handle SHL-specific error statuses
  if (result.status === 401) {
    const remaining = result.parsedBody?.remainingAttempts;
    throw new Error(
      `Invalid passcode.${remaining != null ? ` ${remaining} attempts remaining.` : ''}`
    );
  }

  if (result.status === 404) {
    throw new Error('This SHL is no longer active (deactivated or expired).');
  }

  if (result.status === 429) {
    throw new Error('Rate limited by SHL server. Please try again later.');
  }

  if (result.status && result.status >= 400) {
    throw new Error(`SHL manifest fetch failed: ${result.status}`);
  }

  return result.parsedBody || JSON.parse(result.body);
}


// ════════════════════════════════════════════════════════
//  JWE Decryptor (browser-side using jose + pako)
// ════════════════════════════════════════════════════════

const MAX_DECOMPRESSED_SIZE = 5_000_000; // 5 MB DoS protection

async function decryptJweClient(jweString, keyBytes) {
  const { compactDecrypt } = window.jose;

  const { plaintext, protectedHeader } = await compactDecrypt(jweString, keyBytes, {
    inflateRaw: async (input) => {
      const decompressed = pako.inflateRaw(input);
      if (decompressed.length > MAX_DECOMPRESSED_SIZE) {
        throw new Error('Decompressed payload exceeds maximum allowed size');
      }
      return decompressed;
    },
    contentEncryptionAlgorithms: ['A256GCM'],
    keyManagementAlgorithms: ['dir'],
  });

  return {
    content: plaintext,
    contentType: protectedHeader.cty,
  };
}

async function decryptToStringClient(jweString, keyBytes) {
  const { content, contentType } = await decryptJweClient(jweString, keyBytes);
  return {
    text: new TextDecoder().decode(content),
    contentType,
  };
}


// ════════════════════════════════════════════════════════
//  FHIR Extractor (browser-side)
// ════════════════════════════════════════════════════════

async function extractHealthDataClient(manifest, keyBytes, proxyBaseUrl, token) {
  const results = {
    fhirBundles: [],
    pdfs: [],
    raw: [],
  };

  for (const file of manifest.files || []) {
    let text;
    let contentType = file.contentType;

    try {
      if (file.embedded) {
        const decrypted = await decryptToStringClient(file.embedded, keyBytes);
        text = decrypted.text;
        if (decrypted.contentType) contentType = decrypted.contentType;
      } else if (file.location) {
        // Fetch file via CORS proxy (still encrypted)
        const result = await proxyFetch(proxyBaseUrl, token, {
          url: file.location,
          method: 'GET',
        });
        const jwe = result.body;
        const decrypted = await decryptToStringClient(jwe, keyBytes);
        text = decrypted.text;
        if (decrypted.contentType) contentType = decrypted.contentType;
      } else {
        continue;
      }
    } catch (err) {
      console.warn('Failed to decrypt SHL file:', err.message);
      continue;
    }

    // Route by content type
    if (contentType?.includes('fhir+json') || contentType?.includes('application/json')) {
      const parsed = JSON.parse(text);
      results.fhirBundles.push(parsed);
      const pdfs = extractPdfsFromBundle(parsed);
      results.pdfs.push(...pdfs);
    } else if (contentType?.includes('smart-health-card')) {
      try {
        const shc = JSON.parse(text);
        results.raw.push({ type: 'smart-health-card', data: shc });
        if (shc.verifiableCredential) {
          for (const jws of shc.verifiableCredential) {
            const bundle = decodeShcJwsBrowser(jws);
            if (bundle) results.fhirBundles.push(bundle);
          }
        }
      } catch {
        results.raw.push({ type: 'smart-health-card', data: text });
      }
    } else if (contentType?.includes('smart-api-access')) {
      results.raw.push({ type: 'smart-api-access', data: JSON.parse(text) });
    } else {
      let handled = false;
      try {
        const parsed = JSON.parse(text);
        if (parsed.resourceType) {
          results.fhirBundles.push(parsed);
          const pdfs = extractPdfsFromBundle(parsed);
          results.pdfs.push(...pdfs);
          handled = true;
        }
      } catch { /* not JSON */ }
      if (!handled) {
        results.raw.push({ type: contentType || 'unknown', data: text });
      }
    }
  }

  return results;
}


function extractPdfsFromBundle(resource) {
  const pdfs = [];
  if (!resource) return pdfs;

  const entries =
    resource.resourceType === 'Bundle' && resource.entry
      ? resource.entry.map((e) => e.resource).filter(Boolean)
      : [resource];

  for (const res of entries) {
    if (res.resourceType !== 'DocumentReference') continue;

    for (const content of res.content || []) {
      const att = content.attachment;
      if (!att) continue;

      if (att.contentType === 'application/pdf') {
        const filename =
          att.title || att.url?.split('/').pop() || `document-${Date.now()}.pdf`;

        if (att.data) {
          pdfs.push({
            filename: sanitizeFilename(filename),
            data: base64ToUint8Array(att.data),
            dataBase64: att.data,
          });
        } else if (att.url) {
          pdfs.push({
            filename: sanitizeFilename(filename),
            url: att.url,
          });
        }
      }
    }
  }

  return pdfs;
}


function decodeShcJwsBrowser(jws) {
  try {
    const parts = jws.split('.');
    if (parts.length !== 3) return null;

    const payloadBytes = base64urlDecode(parts[1]);
    const decompressed = pako.inflateRaw(payloadBytes);
    const text = new TextDecoder().decode(decompressed);
    return JSON.parse(text);
  } catch {
    return null;
  }
}


function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}


function validateFhirBundlesClient(fhirBundles) {
  const errors = [];

  if (!fhirBundles || fhirBundles.length === 0) {
    return { valid: true, errors: [] };
  }

  for (let i = 0; i < fhirBundles.length; i++) {
    const bundle = fhirBundles[i];

    if (!bundle || typeof bundle !== 'object') {
      errors.push(`Bundle ${i + 1}: not a valid object`);
      continue;
    }

    if (!bundle.resourceType) {
      errors.push(`Bundle ${i + 1}: missing resourceType`);
      continue;
    }

    if (bundle.resourceType === 'Bundle') {
      if (bundle.entry && Array.isArray(bundle.entry)) {
        for (let j = 0; j < bundle.entry.length; j++) {
          const entry = bundle.entry[j];
          if (entry.resource && !entry.resource.resourceType) {
            errors.push(`Bundle ${i + 1}, entry ${j + 1}: resource missing resourceType`);
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}


// ════════════════════════════════════════════════════════
//  Main pipeline: processScanClientSide()
// ════════════════════════════════════════════════════════

/**
 * Full client-side SHL processing pipeline.
 *
 * 1. Parse SHL URI (browser)
 * 2. Fetch encrypted manifest via CORS proxy (server sees only encrypted blobs)
 * 3. Decrypt JWE in browser (server never sees decrypted PHI)
 * 4. Parse FHIR / extract PDFs (browser)
 * 5. Send decrypted data to server for routing to storage destination
 *
 * @param {string} qrText - Raw QR code text
 * @param {string} slug - Organization slug
 * @param {string} token - Auth token
 * @param {object} options - { passcode, orgName, saveFormat }
 * @returns {object} - Same response shape as the old /api/orgs/:slug/scan endpoint
 */
async function processScanClientSide(qrText, slug, token, options = {}) {
  const { passcode = null, orgName = 'Killtheclipboard' } = options;

  // Step 1: Parse SHL URI (entirely in browser)
  let shlPayload;
  try {
    shlPayload = parseShlUri(qrText);
  } catch (err) {
    throw new Error(err.message);
  }

  if (!shlPayload) {
    return { status: 'not_shl', message: 'QR code does not contain a SMART Health Link.' };
  }

  if (shlPayload.flag.includes('P') && !passcode) {
    return { status: 'need_passcode', label: shlPayload.label };
  }

  const proxyBaseUrl = `/api/orgs/${slug}/shl-proxy`;

  // Step 2: Fetch encrypted manifest via CORS proxy
  const manifest = await fetchManifestClient(shlPayload, proxyBaseUrl, token, {
    recipient: orgName,
    passcode,
  });

  // Step 3+4: Decrypt and extract in browser
  const results = await extractHealthDataClient(manifest, shlPayload.key, proxyBaseUrl, token);

  // Validate FHIR data
  if (results.fhirBundles.length > 0) {
    const validation = validateFhirBundlesClient(results.fhirBundles);
    if (!validation.valid) {
      return {
        status: 'validation_failed',
        error: `Invalid FHIR data: ${validation.errors.join('; ')}`,
        label: shlPayload.label,
      };
    }
  }

  if (results.fhirBundles.length === 0 && results.pdfs.length === 0) {
    return {
      status: 'validation_failed',
      error: 'No valid FHIR bundles or PDF documents found in the scanned data.',
      label: shlPayload.label,
    };
  }

  // Step 5: Send decrypted data to server for routing to configured storage
  // The server handles Drive/OneDrive/Box/Gmail/Outlook/API routing
  const routeResp = await fetch(`/api/orgs/${slug}/route`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      fhirBundles: results.fhirBundles,
      pdfs: results.pdfs.map(p => ({
        filename: p.filename,
        dataBase64: p.dataBase64 || (p.data ? uint8ArrayToBase64(p.data) : null),
        url: p.url || null,
      })),
      label: shlPayload.label,
    }),
  });

  if (!routeResp.ok) {
    if (routeResp.status === 401) {
      throw new Error('SESSION_EXPIRED');
    }
    const err = await routeResp.json().catch(() => ({ error: 'Routing failed' }));
    throw new Error(err.error || 'Failed to route data to storage destination');
  }

  return routeResp.json();
}
