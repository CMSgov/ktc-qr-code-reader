/**
 * Upload extracted health data to Microsoft OneDrive.
 *
 * Uses Microsoft Graph API with OAuth2 refresh tokens.
 * Requires ONEDRIVE_CLIENT_ID and ONEDRIVE_CLIENT_SECRET env vars.
 */

/**
 * Get a fresh access token from a refresh token.
 */
async function getAccessToken(refreshToken) {
  const clientId = process.env.ONEDRIVE_CLIENT_ID;
  const clientSecret = process.env.ONEDRIVE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'OneDrive not configured. Set ONEDRIVE_CLIENT_ID and ONEDRIVE_CLIENT_SECRET env vars.',
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: 'Files.ReadWrite.All offline_access',
  });

  const resp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`OneDrive token refresh failed: ${err.error_description || resp.statusText}`);
  }

  const data = await resp.json();
  return data.access_token;
}

/**
 * Upload a single file to a OneDrive folder path.
 */
async function uploadFile(accessToken, folderPath, filename, content, contentType) {
  const encodedPath = encodeURIComponent(`${folderPath}/${filename}`).replace(/%2F/g, '/');
  const url = `https://graph.microsoft.com/v1.0/me/drive/root:${encodedPath}:/content`;

  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': contentType,
    },
    body: content,
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(
      `OneDrive upload failed for ${filename}: ${err.error?.message || resp.statusText}`,
    );
  }

  return resp.json();
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
 * Upload results to OneDrive.
 *
 * @param {object} results - { fhirBundles, pdfs, raw }
 * @param {object} onedriveConfig - { refreshToken, folderPath }
 * @param {object} options - { verbose }
 * @returns {{ folderPath: string, files: object[] }}
 */
export async function uploadToOnedrive(results, onedriveConfig, options = {}) {
  const { verbose = false } = options;
  const { refreshToken, folderPath: basePath } = onedriveConfig;

  if (!refreshToken) throw new Error('OneDrive not connected.');
  const folderBase = basePath || '/KillTheClipboard';

  const accessToken = await getAccessToken(refreshToken);

  // Create timestamped subfolder
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const patient = extractPatientName(results);
  const subfolderName = patient
    ? `${patient.lastName}_${patient.firstInitial}_${timestamp}`
    : `scan-${timestamp}`;
  const folderPath = `${folderBase}/${subfolderName}`;

  const uploaded = [];

  // Upload FHIR bundles
  for (let i = 0; i < results.fhirBundles.length; i++) {
    const filename = `bundle-${i}.json`;
    const content = JSON.stringify(results.fhirBundles[i], null, 2);
    const file = await uploadFile(accessToken, folderPath, filename, content, 'application/json');
    uploaded.push({ filename, id: file.id, link: file.webUrl });
    if (verbose) console.error(`OneDrive: uploaded ${filename}`);
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

    const file = await uploadFile(
      accessToken,
      folderPath,
      pdf.filename,
      pdfBuffer,
      'application/pdf',
    );
    uploaded.push({ filename: pdf.filename, id: file.id, link: file.webUrl });
    if (verbose) console.error(`OneDrive: uploaded ${pdf.filename}`);
  }

  // Upload summary
  const summary = {
    timestamp: new Date().toISOString(),
    fhirBundles: results.fhirBundles.length,
    pdfs: results.pdfs.length,
    rawEntries: results.raw.length,
    folderPath,
    files: uploaded,
  };

  await uploadFile(
    accessToken,
    folderPath,
    'summary.json',
    JSON.stringify(summary, null, 2),
    'application/json',
  );

  return {
    folderPath,
    folderLink: uploaded[0]?.link?.replace(/\/[^/]+$/, '') || null,
    files: uploaded,
  };
}

/**
 * Get the OAuth2 authorization URL for OneDrive.
 */
export function getOnedriveAuthUrl(redirectUri, state) {
  const clientId = process.env.ONEDRIVE_CLIENT_ID;
  if (!clientId) return null;

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'Files.ReadWrite.All offline_access',
    state,
    prompt: 'consent',
  });

  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeOnedriveCode(code, redirectUri) {
  const clientId = process.env.ONEDRIVE_CLIENT_ID;
  const clientSecret = process.env.ONEDRIVE_CLIENT_SECRET;

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const resp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error_description || 'Token exchange failed');
  }

  return resp.json();
}
