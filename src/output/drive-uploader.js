import { google } from 'googleapis';
import { Readable } from 'node:stream';

/**
 * Parse a Google Drive folder ID from a URL or raw ID.
 */
export function parseFolderId(input) {
  if (!input) return null;
  // Full URL: https://drive.google.com/drive/folders/FOLDER_ID?...
  const match = input.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // Raw ID (no slashes)
  if (/^[a-zA-Z0-9_-]+$/.test(input)) return input;
  return null;
}

/**
 * Build a Google Drive client.
 * Supports OAuth2 (preferred) or service account auth.
 */
function getDriveClient(driveConfig) {
  const { clientId, clientSecret, refreshToken, serviceAccountKey } = driveConfig;

  // Prefer OAuth2 if refresh token is available
  if (clientId && clientSecret && refreshToken) {
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });
    return google.drive({ version: 'v3', auth: oauth2 });
  }

  // Fall back to service account
  if (serviceAccountKey) {
    let credentials;
    if (typeof serviceAccountKey === 'string') {
      try {
        credentials = JSON.parse(serviceAccountKey);
      } catch {
        credentials = JSON.parse(Buffer.from(serviceAccountKey, 'base64').toString('utf-8'));
      }
    } else {
      credentials = serviceAccountKey;
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });

    return google.drive({ version: 'v3', auth });
  }

  throw new Error(
    'Google Drive auth not configured. Either set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN (OAuth2) or GOOGLE_SERVICE_ACCOUNT_KEY.',
  );
}

/**
 * Build an OAuth2 client for the auth flow (not for Drive uploads).
 */
export function getOAuth2Client(config) {
  const { clientId, clientSecret } = config.output.drive;
  if (!clientId || !clientSecret) return null;

  const publicUrl = config.server.publicUrl || `http://localhost:${config.server.port || 3000}`;
  const redirectUri = config.output.drive.redirectUri || `${publicUrl}/auth/google/callback`;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Extract patient name from FHIR bundles for folder naming.
 * Returns { lastName, firstInitial } or null.
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
 * Upload extracted health data to a Google Drive folder.
 */
export async function uploadToDrive(results, driveConfig, options = {}) {
  const { verbose = false } = options;
  const { folderId: rawFolderId } = driveConfig;

  const folderId = parseFolderId(rawFolderId);
  if (!folderId) {
    throw new Error('Google Drive folder ID is not configured. Set GOOGLE_DRIVE_FOLDER env var.');
  }

  const drive = getDriveClient(driveConfig);

  // Create a subfolder named LastName_FirstInitial_Timestamp (or scan-Timestamp if no patient)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const patient = extractPatientName(results);
  const subfolderName = patient
    ? `${patient.lastName}_${patient.firstInitial}_${timestamp}`
    : `scan-${timestamp}`;

  const folderRes = await drive.files.create({
    requestBody: {
      name: subfolderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [folderId],
    },
    fields: 'id, webViewLink',
  });

  const subfolderId = folderRes.data.id;
  const subfolderLink = folderRes.data.webViewLink;
  if (verbose) console.error(`Created Drive folder: ${subfolderName} (${subfolderLink})`);

  const uploaded = { fhir: [], pdfs: [], folderId: subfolderId, folderLink: subfolderLink };

  // Upload FHIR bundles
  for (let i = 0; i < results.fhirBundles.length; i++) {
    const filename = `bundle-${i}.json`;
    const content = JSON.stringify(results.fhirBundles[i], null, 2);

    const res = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [subfolderId],
      },
      media: {
        mimeType: 'application/json',
        body: Readable.from(content),
      },
      fields: 'id, webViewLink',
    });

    uploaded.fhir.push({ filename, id: res.data.id, link: res.data.webViewLink });
    if (verbose) console.error(`Uploaded ${filename} to Drive`);
  }

  // Upload PDFs
  for (const pdf of results.pdfs) {
    let pdfBuffer = pdf.data;

    if (!pdfBuffer && pdf.url) {
      try {
        const resp = await fetch(pdf.url);
        if (resp.ok) {
          pdfBuffer = Buffer.from(await resp.arrayBuffer());
        }
      } catch (err) {
        if (verbose) console.error(`Failed to fetch PDF from ${pdf.url}: ${err.message}`);
        continue;
      }
    }

    if (!pdfBuffer) continue;

    const res = await drive.files.create({
      requestBody: {
        name: pdf.filename,
        parents: [subfolderId],
      },
      media: {
        mimeType: 'application/pdf',
        body: Readable.from(pdfBuffer),
      },
      fields: 'id, webViewLink',
    });

    uploaded.pdfs.push({ filename: pdf.filename, id: res.data.id, link: res.data.webViewLink });
    if (verbose) console.error(`Uploaded ${pdf.filename} to Drive`);
  }

  // Upload summary
  const summary = {
    timestamp: new Date().toISOString(),
    fhirBundles: uploaded.fhir.length,
    pdfs: uploaded.pdfs.length,
    rawEntries: results.raw.length,
    driveFolder: subfolderLink,
    files: {
      fhir: uploaded.fhir,
      pdfs: uploaded.pdfs,
    },
  };

  await drive.files.create({
    requestBody: {
      name: 'summary.json',
      parents: [subfolderId],
    },
    media: {
      mimeType: 'application/json',
      body: Readable.from(JSON.stringify(summary, null, 2)),
    },
  });

  return summary;
}
