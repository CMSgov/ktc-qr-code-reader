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
//  Fetch: direct (Core) or via CORS proxy
// ════════════════════════════════════════════════════════

// Timeouts to avoid hanging on slow or unresponsive SHL servers (robustness + DoS mitigation)
const FETCH_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Direct fetch (no proxy). Used when proxyBaseUrl is null (Core standalone)
 * or for try-direct-then-proxy. Returns shape compatible with proxy response.
 */
async function directFetch(url, { method = 'GET', body = null, headers = {} }) {
  const opts = { method, headers: { ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
  if (body != null && method !== 'GET') {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let parsedBody = null;
  try {
    parsedBody = text ? JSON.parse(text) : null;
  } catch {
    // response is not JSON (e.g. raw JWE)
  }
  return {
    status: resp.status,
    body: text,
    parsedBody,
    ok: resp.ok,
  };
}

/**
 * Fetch via server CORS proxy (encrypted only). Token optional for Core proxy.
 */
async function proxyFetch(proxyBaseUrl, token, { url, method = 'GET', body = null, headers = {} }) {
  const headersOut = { 'Content-Type': 'application/json' };
  if (token) {
    headersOut['Authorization'] = `Bearer ${token}`;
  }
  const resp = await fetch(proxyBaseUrl, {
    method: 'POST',
    headers: headersOut,
    body: JSON.stringify({ url, method, body, headers }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: 'Proxy request failed' }));
    throw new Error(err.error || `Proxy fetch failed: ${resp.status}`);
  }

  return resp.json();
}

/**
 * Fetch manifest: direct first when possible, optional proxy fallback.
 * fetchOptions: { proxyBaseUrl?, token? }. If proxyBaseUrl is null/undefined, direct only.
 */
async function fetchManifestClient(shlPayload, fetchOptions, config = {}) {
  const { recipient = 'Killtheclipboard', passcode = null } = config;
  const hasPasscode = shlPayload.flag.includes('P');
  const isDirect = shlPayload.flag.includes('U');
  const proxyBaseUrl = fetchOptions.proxyBaseUrl ?? null;
  const token = fetchOptions.token ?? null;
  const proxyMode = fetchOptions.proxyMode ?? 'fallback';

  if (hasPasscode && !passcode) {
    throw new Error('This SHL requires a passcode.');
  }

  const tryDirect = async () => {
    if (isDirect) {
      const url = new URL(shlPayload.url);
      url.searchParams.set('recipient', recipient);
      const result = await directFetch(url.toString(), { method: 'GET' });
      if (!result.ok) throw new Error(`Manifest fetch failed: ${result.status}`);
      return {
        files: [{ contentType: 'application/jose', embedded: result.body }],
      };
    }
    const postBody = { recipient };
    if (hasPasscode && passcode) postBody.passcode = passcode;
    const result = await directFetch(shlPayload.url, {
      method: 'POST',
      body: postBody,
      headers: { 'Content-Type': 'application/json' },
    });
    if (result.status === 401) {
      const remaining = result.parsedBody?.remainingAttempts;
      throw new Error(
        `Invalid passcode.${remaining != null ? ` ${remaining} attempts remaining.` : ''}`,
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
    return result.parsedBody || (result.body ? JSON.parse(result.body) : null);
  };

  const useProxy = async () => {
    if (isDirect) {
      const url = new URL(shlPayload.url);
      url.searchParams.set('recipient', recipient);
      const result = await proxyFetch(proxyBaseUrl, token, { url: url.toString(), method: 'GET' });
      return {
        files: [{ contentType: 'application/jose', embedded: result.body }],
      };
    }
    const postBody = { recipient };
    if (hasPasscode && passcode) postBody.passcode = passcode;
    const result = await proxyFetch(proxyBaseUrl, token, {
      url: shlPayload.url,
      method: 'POST',
      body: postBody,
      headers: { 'Content-Type': 'application/json' },
    });
    if (result.status === 401) {
      const remaining = result.parsedBody?.remainingAttempts;
      throw new Error(
        `Invalid passcode.${remaining != null ? ` ${remaining} attempts remaining.` : ''}`,
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
  };

  if (proxyBaseUrl && proxyMode === 'only') {
    return await useProxy();
  }
  if (proxyBaseUrl && proxyMode === 'prefer') {
    try {
      return await useProxy();
    } catch {
      return await tryDirect();
    }
  }
  if (proxyBaseUrl) {
    try {
      return await tryDirect();
    } catch {
      return await useProxy();
    }
  }
  return await tryDirect();
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

// Cap number of manifest files to prevent memory exhaustion and long-running tabs (robustness)
const MAX_MANIFEST_FILES = 100;

async function extractHealthDataClient(manifest, keyBytes, fetchOptions) {
  const results = {
    fhirBundles: [],
    pdfs: [],
    raw: [],
  };
  const proxyBaseUrl = fetchOptions.proxyBaseUrl ?? null;
  const token = fetchOptions.token ?? null;

  const files = (manifest.files || []).slice(0, MAX_MANIFEST_FILES);
  for (const file of files) {
    let text;
    let contentType = file.contentType;

    try {
      if (file.embedded) {
        const decrypted = await decryptToStringClient(file.embedded, keyBytes);
        text = decrypted.text;
        if (decrypted.contentType) contentType = decrypted.contentType;
      } else if (file.location) {
        let jwe;
        if (proxyBaseUrl) {
          const result = await proxyFetch(proxyBaseUrl, token, {
            url: file.location,
            method: 'GET',
          });
          jwe = result.body;
        } else {
          const result = await directFetch(file.location, { method: 'GET' });
          if (!result.ok) throw new Error(`File fetch failed: ${result.status}`);
          jwe = result.body;
        }
        const decrypted = await decryptToStringClient(jwe, keyBytes);
        text = decrypted.text;
        if (decrypted.contentType) contentType = decrypted.contentType;
      } else {
        continue;
      }
    } catch {
      // Decryption or fetch failed for this file; skip (do not log to avoid timing/error leakage)
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
      } catch {
        /* not JSON */
      }
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
        const filename = att.title || att.url?.split('/').pop() || `document-${Date.now()}.pdf`;

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

// Same limit as JWE path to prevent decompression-bomb DoS via SHC payloads
const MAX_SHC_DECOMPRESSED_SIZE = 5_000_000; // 5 MB

function decodeShcJwsBrowser(jws) {
  try {
    const parts = jws.split('.');
    if (parts.length !== 3) return null;

    const payloadBytes = base64urlDecode(parts[1]);
    const decompressed = pako.inflateRaw(payloadBytes);
    if (decompressed.length > MAX_SHC_DECOMPRESSED_SIZE) return null;
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

  const fetchOptions = {
    proxyBaseUrl: `/api/orgs/${slug}/shl-proxy`,
    token,
    // Managed scanner defaults to direct fetch with proxy fallback for resilience.
    proxyMode: 'fallback',
  };

  // Step 2: Fetch encrypted manifest (direct or via CORS proxy)
  const manifest = await fetchManifestClient(shlPayload, fetchOptions, {
    recipient: orgName,
    passcode,
  });

  // Step 3+4: Decrypt and extract in browser
  const results = await extractHealthDataClient(manifest, shlPayload.key, fetchOptions);

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
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      fhirBundles: results.fhirBundles,
      pdfs: results.pdfs.map((p) => ({
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

  const routeData = await routeResp.json();

  // Preserve client-side extracted data for scanner UI flows (preview/download),
  // while allowing the sidecar API to return metadata-only PDFs.
  routeData.fhirBundles = routeData.fhirBundles || results.fhirBundles;
  const extractedPdfs = results.pdfs.map((p) => ({
    filename: p.filename,
    dataBase64: p.dataBase64 || (p.data ? uint8ArrayToBase64(p.data) : null),
    url: p.url || null,
  }));
  if (Array.isArray(routeData.pdfs) && routeData.pdfs.length > 0) {
    const localPdfByName = new Map(extractedPdfs.map((p) => [p.filename, p]));
    routeData.pdfs = routeData.pdfs.map((pdf) => {
      const local = localPdfByName.get(pdf.filename);
      if (!local) return pdf;
      return {
        ...pdf,
        dataBase64: pdf.dataBase64 || local.dataBase64 || null,
      };
    });
  } else {
    routeData.pdfs = extractedPdfs;
  }

  return routeData;
}

// ════════════════════════════════════════════════════════
//  Core pipeline: no /route — save via Web Share / download only
// ════════════════════════════════════════════════════════

/**
 * Core client-only pipeline. Does not call /route; returns extracted data
 * for the UI to render Card Details and Web Share / download.
 *
 * @param {string} qrText - Raw QR code text
 * @param {object} options - { passcode, orgName, proxyBaseUrl? }
 *   proxyBaseUrl: optional CORS proxy URL (no auth). If null/omitted, direct fetch only.
 * @returns {object} - { status, fhirBundles?, pdfs?, label?, error?, ... }
 */
async function processScanCore(qrText, options = {}) {
  const { passcode = null, orgName = 'Killtheclipboard', proxyBaseUrl = null } = options;

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

  const fetchOptions = { proxyBaseUrl, token: null };

  const manifest = await fetchManifestClient(shlPayload, fetchOptions, {
    recipient: orgName,
    passcode,
  });

  const results = await extractHealthDataClient(manifest, shlPayload.key, fetchOptions);

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

  return {
    status: 'ok',
    fhirBundles: results.fhirBundles,
    pdfs: results.pdfs,
    label: shlPayload.label,
    storageType: 'download',
  };
}

// Expose entry points for scanner.html (oxlint sees these as "used")
if (typeof window !== 'undefined') {
  window.processScanCore = processScanCore;
  window.processScanClientSide = processScanClientSide;
}
