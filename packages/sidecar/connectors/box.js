/**
 * Upload extracted health data to Box.
 *
 * Uses Box API with OAuth2 refresh tokens.
 * Requires BOX_CLIENT_ID and BOX_CLIENT_SECRET env vars.
 */

/**
 * Get a fresh access token from a refresh token.
 */
async function getAccessToken(refreshToken) {
  const clientId = process.env.BOX_CLIENT_ID;
  const clientSecret = process.env.BOX_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Box not configured. Set BOX_CLIENT_ID and BOX_CLIENT_SECRET env vars.');
  }

  const resp = await fetch('https://api.box.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Box token refresh failed: ${err.error_description || resp.statusText}`);
  }

  const data = await resp.json();
  return { accessToken: data.access_token, newRefreshToken: data.refresh_token };
}

/**
 * Create a subfolder in Box.
 */
async function createFolder(accessToken, parentId, name) {
  const resp = await fetch('https://api.box.com/2.0/folders', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      parent: { id: parentId },
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Box folder creation failed: ${err.message || resp.statusText}`);
  }

  return resp.json();
}

/**
 * Upload a file to a Box folder.
 */
async function uploadFile(accessToken, folderId, filename, content) {
  // Box uses multipart upload
  const boundary = '----BoxUploadBoundary' + Date.now();
  const attributes = JSON.stringify({
    name: filename,
    parent: { id: folderId },
  });

  const contentBuffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

  const parts = [];
  parts.push(`--${boundary}\r\n`);
  parts.push('Content-Disposition: form-data; name="attributes"\r\n\r\n');
  parts.push(attributes + '\r\n');
  parts.push(`--${boundary}\r\n`);
  parts.push(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`);
  parts.push('Content-Type: application/octet-stream\r\n\r\n');

  const header = Buffer.from(parts.join(''));
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, contentBuffer, footer]);

  const resp = await fetch('https://upload.box.com/api/2.0/files/content', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length.toString(),
    },
    body,
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Box upload failed for ${filename}: ${err.message || resp.statusText}`);
  }

  const data = await resp.json();
  return data.entries?.[0] || {};
}

/**
 * Extract patient name for folder naming.
 */
function extractPatientName(results) {
  for (const bundle of results.fhirBundles || []) {
    for (const entry of bundle.entry || []) {
      const r = entry.resource;
      if (r?.resourceType === 'Patient' && r.name?.[0]) {
        const name = r.name[0];
        const lastName = name.family || '';
        const firstName = name.given?.[0] || '';
        if (lastName) {
          return {
            lastName: lastName.replace(/[^a-zA-Z]/g, ''),
            firstInitial: firstName ? firstName[0].toUpperCase() : '',
          };
        }
      }
    }
  }
  return null;
}

/**
 * Upload results to Box.
 *
 * @param {object} results - { fhirBundles, pdfs, raw }
 * @param {object} boxConfig - { refreshToken, folderId }
 * @param {object} options - { verbose }
 * @returns {{ folderId: string, folderLink: string, files: object[], newRefreshToken: string }}
 */
export async function uploadToBox(results, boxConfig, options = {}) {
  const { verbose = false } = options;
  const { refreshToken, folderId: parentFolderId } = boxConfig;

  if (!refreshToken) throw new Error('Box not connected.');
  if (!parentFolderId) throw new Error('Box folder ID not configured.');

  const { accessToken, newRefreshToken } = await getAccessToken(refreshToken);

  // Create timestamped subfolder
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const patient = extractPatientName(results);
  const subfolderName = patient
    ? `${patient.lastName}_${patient.firstInitial}_${timestamp}`
    : `scan-${timestamp}`;

  const folder = await createFolder(accessToken, parentFolderId, subfolderName);
  const subfolderId = folder.id;

  const uploaded = [];

  // Upload FHIR bundles
  for (let i = 0; i < results.fhirBundles.length; i++) {
    const filename = `bundle-${i}.json`;
    const content = JSON.stringify(results.fhirBundles[i], null, 2);
    const file = await uploadFile(accessToken, subfolderId, filename, content);
    uploaded.push({ filename, id: file.id });
    if (verbose) console.error(`Box: uploaded ${filename}`);
  }

  // Upload PDFs
  for (const pdf of results.pdfs) {
    let pdfBuffer = pdf.data;

    if (!pdfBuffer && pdf.url) {
      try {
        const resp = await fetch(pdf.url);
        if (resp.ok) pdfBuffer = Buffer.from(await resp.arrayBuffer());
      } catch {
        continue;
      }
    }

    if (!pdfBuffer) continue;

    const file = await uploadFile(accessToken, subfolderId, pdf.filename, pdfBuffer);
    uploaded.push({ filename: pdf.filename, id: file.id });
    if (verbose) console.error(`Box: uploaded ${pdf.filename}`);
  }

  // Upload summary
  const summary = {
    timestamp: new Date().toISOString(),
    fhirBundles: results.fhirBundles.length,
    pdfs: results.pdfs.length,
    rawEntries: results.raw.length,
    files: uploaded,
  };

  await uploadFile(accessToken, subfolderId, 'summary.json', JSON.stringify(summary, null, 2));

  const folderLink = `https://app.box.com/folder/${subfolderId}`;

  return {
    folderId: subfolderId,
    folderLink,
    files: uploaded,
    newRefreshToken, // Box rotates refresh tokens; caller should store this
  };
}

/**
 * Get the OAuth2 authorization URL for Box.
 */
export function getBoxAuthUrl(redirectUri, state) {
  const clientId = process.env.BOX_CLIENT_ID;
  if (!clientId) return null;

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
  });

  return `https://account.box.com/api/oauth2/authorize?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeBoxCode(code) {
  const clientId = process.env.BOX_CLIENT_ID;
  const clientSecret = process.env.BOX_CLIENT_SECRET;

  const resp = await fetch('https://api.box.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
    }).toString(),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error_description || 'Token exchange failed');
  }

  return resp.json();
}
