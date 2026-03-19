import { inflateRawSync } from 'node:zlib';
import { decryptToString } from './decryptor.js';
import { fetchFile } from './manifest.js';

/**
 * Process manifest files: decrypt, parse, and extract FHIR bundles + PDFs.
 *
 * @param {object} manifest - The manifest response from fetchManifest()
 * @param {Uint8Array} keyBytes - 32-byte AES key from SHL payload
 * @param {object} options - Processing options
 * @returns {{ fhirBundles: object[], pdfs: Array<{filename: string, data: Buffer}>, raw: object[] }}
 */
export async function extractHealthData(manifest, keyBytes, options = {}) {
  const { maxDecompressedSize = 5_000_000, verbose = false } = options;

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
        // Embedded JWE in the manifest
        const decrypted = await decryptToString(file.embedded, keyBytes, maxDecompressedSize);
        text = decrypted.text;
        // Prefer content type from JWE header; fall back to manifest entry
        if (decrypted.contentType) contentType = decrypted.contentType;
      } else if (file.location) {
        // Fetch from location URL then decrypt
        const jwe = await fetchFile(file.location);
        const decrypted = await decryptToString(jwe, keyBytes, maxDecompressedSize);
        text = decrypted.text;
        // Prefer content type from JWE header; fall back to manifest entry
        if (decrypted.contentType) contentType = decrypted.contentType;
      } else {
        if (verbose) console.error('Skipping manifest entry with no embedded content or location');
        continue;
      }
    } catch (err) {
      if (verbose) console.error(`Failed to decrypt file: ${err.message}`);
      continue;
    }

    if (verbose) console.error(`Decrypted file, contentType: ${contentType}`);

    // Route by content type
    if (contentType?.includes('fhir+json') || contentType?.includes('application/json')) {
      const parsed = JSON.parse(text);
      results.fhirBundles.push(parsed);

      // Extract PDFs from DocumentReference resources
      const pdfs = extractPdfsFromBundle(parsed);
      results.pdfs.push(...pdfs);
    } else if (contentType?.includes('smart-health-card')) {
      // SHC: JSON with verifiableCredential array of JWS strings
      try {
        const shc = JSON.parse(text);
        results.raw.push({ type: 'smart-health-card', data: shc });

        // Decode JWS payloads to get embedded FHIR bundles
        if (shc.verifiableCredential) {
          for (const jws of shc.verifiableCredential) {
            const bundle = decodeShcJws(jws);
            if (bundle) results.fhirBundles.push(bundle);
          }
        }
      } catch {
        results.raw.push({ type: 'smart-health-card', data: text });
      }
    } else if (contentType?.includes('smart-api-access')) {
      results.raw.push({ type: 'smart-api-access', data: JSON.parse(text) });
    } else {
      // Unknown content type — try to detect FHIR JSON by parsing
      let handled = false;
      try {
        const parsed = JSON.parse(text);
        if (parsed.resourceType) {
          // Looks like a FHIR resource
          results.fhirBundles.push(parsed);
          const pdfs = extractPdfsFromBundle(parsed);
          results.pdfs.push(...pdfs);
          handled = true;
        }
      } catch {
        // Not JSON
      }
      if (!handled) {
        results.raw.push({ type: contentType || 'unknown', data: text });
      }
    }
  }

  return results;
}

/**
 * Walk a FHIR Bundle looking for DocumentReference resources with PDF attachments.
 */
function extractPdfsFromBundle(resource) {
  const pdfs = [];

  if (!resource) return pdfs;

  // Handle Bundle with entries
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
          // Base64-encoded PDF inline
          pdfs.push({
            filename: sanitizeFilename(filename),
            data: Buffer.from(att.data, 'base64'),
          });
        } else if (att.url) {
          // URL reference — mark for later fetching
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

/**
 * Decode a SMART Health Card JWS to extract the FHIR bundle payload.
 * SHC JWS payloads are base64url-encoded, then zlib-compressed.
 */
function decodeShcJws(jws) {
  try {
    const parts = jws.split('.');
    if (parts.length !== 3) return null;

    const payloadBytes = Buffer.from(parts[1], 'base64url');

    // SHC payloads are DEFLATE-compressed
    const decompressed = inflateRawSync(payloadBytes);
    return JSON.parse(decompressed.toString('utf-8'));
  } catch {
    return null;
  }
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

/**
 * Validate that FHIR bundles contain well-formed FHIR resources.
 * Returns { valid: boolean, errors: string[] }
 */
export function validateFhirBundles(fhirBundles) {
  const errors = [];

  if (!fhirBundles || fhirBundles.length === 0) {
    return { valid: true, errors: [] }; // No bundles is fine (e.g., PDF-only)
  }

  for (let i = 0; i < fhirBundles.length; i++) {
    const bundle = fhirBundles[i];

    if (!bundle || typeof bundle !== 'object') {
      errors.push(`Bundle ${i + 1}: not a valid object`);
      continue;
    }

    // Must have a resourceType
    if (!bundle.resourceType) {
      errors.push(`Bundle ${i + 1}: missing resourceType`);
      continue;
    }

    // If it's a Bundle, validate entries
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
