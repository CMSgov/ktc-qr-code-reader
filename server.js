import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './src/config.js';
import { parseShlUri } from './src/shl/uri-parser.js';
import { fetchManifest } from './src/shl/manifest.js';
import { extractHealthData, validateFhirBundles } from './src/shl/fhir-extractor.js';
import { writeToFiles } from './src/output/file-writer.js';
import { postToApi } from './src/output/api-poster.js';
import { uploadToDrive, getOAuth2Client, parseFolderId } from './src/output/drive-uploader.js';
import { sendEmail } from './src/output/email-sender.js';
import { uploadToOnedrive, getOnedriveAuthUrl, exchangeOnedriveCode } from './src/output/onedrive-uploader.js';
import { uploadToBox, getBoxAuthUrl, exchangeBoxCode } from './src/output/box-uploader.js';
import { initDb, createOrg, getOrgBySlug, updateOrgSettings, slugExists } from './src/db.js';
import { hashPassword, verifyPassword, createToken, authMiddleware } from './src/auth.js';
import { readFileSync } from 'node:fs';

// Load version from package.json at startup
const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf-8'));
const APP_VERSION = pkg.version;

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const config = loadConfig();

const PORT = process.env.PORT || config.server?.port || 3000;
const HOST = process.env.HOST || config.server?.host || '0.0.0.0';

const RESERVED_SLUGS = ['register', 'admin', 'api', 'auth', 'public', 'static', 'assets', 'health', 'index.html'];

app.use(express.json({ limit: '10mb' }));

// ── Explicit page routes (before static, so they override index.html default) ──

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'landing.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'register.html'));
});

// Static files (CSS, JS, fonts, images — but NOT index.html as the default for /)
app.use(express.static(join(__dirname, 'public')));

// ── Version endpoint ──
app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION, name: 'Kill the Clipboard' });
});

// ══════════════════════════════════════════════════════════════════
//  LEGACY ROUTES — single-tenant, env-var config (unchanged)
// ══════════════════════════════════════════════════════════════════

// API: process a scanned QR code string (legacy)
app.post('/api/scan', async (req, res) => {
  const { qrText, passcode } = req.body;

  if (!qrText) {
    return res.status(400).json({ error: 'No QR text provided' });
  }

  let shlPayload;
  try {
    shlPayload = parseShlUri(qrText);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!shlPayload) {
    return res.json({ status: 'not_shl', message: 'QR code does not contain a SMART Health Link.' });
  }

  if (shlPayload.flag.includes('P') && !passcode && !config.passcode) {
    return res.json({
      status: 'need_passcode',
      label: shlPayload.label,
      message: 'This link requires a passcode.',
    });
  }

  try {
    const manifest = await fetchManifest(shlPayload, {
      recipient: config.recipient,
      passcode: passcode || config.passcode,
    });

    const results = await extractHealthData(manifest, shlPayload.key, {
      maxDecompressedSize: config.processing?.maxDecompressedSize,
      verbose: false,
    });

    // Validate FHIR data
    if (results.fhirBundles.length > 0) {
      const validation = validateFhirBundles(results.fhirBundles);
      if (!validation.valid) {
        return res.json({
          status: 'validation_failed',
          error: `Invalid FHIR data: ${validation.errors.join('; ')}`,
          label: shlPayload.label,
        });
      }
    }

    let savedTo = null;
    if (['file', 'both', 'all'].includes(config.output.mode)) {
      await writeToFiles(results, config.output.directory, { verbose: false });
      savedTo = config.output.directory;
    }

    if (['api', 'both', 'all'].includes(config.output.mode)) {
      if (config.output.api.url || config.output.api.fhirServerBase) {
        await postToApi(results, config.output.api, { verbose: false });
      }
    }

    let driveLink = null;
    let driveError = null;
    if (['drive', 'all'].includes(config.output.mode)) {
      if (config.output.drive.folderId) {
        try {
          const driveSummary = await uploadToDrive(results, config.output.drive, { verbose: false });
          driveLink = driveSummary.driveFolder;
        } catch (err) {
          driveError = err.message;
          console.error(`Drive upload failed: ${err.message}`);
        }
      }
    }

    const response = {
      status: 'success',
      label: shlPayload.label,
      savedTo,
      driveLink,
      driveError,
      summary: {
        fhirBundles: results.fhirBundles.length,
        pdfs: results.pdfs.length,
        rawEntries: results.raw.length,
      },
      fhirBundles: results.fhirBundles,
      pdfs: results.pdfs.map((p) => ({
        filename: p.filename,
        hasData: !!p.data,
        dataBase64: p.data ? p.data.toString('base64') : null,
        url: p.url || null,
      })),
    };

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: get current config (legacy, non-sensitive)
app.get('/api/config', (req, res) => {
  res.json({
    outputMode: config.output.mode,
    outputDirectory: config.output.directory,
    hasApiUrl: !!config.output.api.url,
    hasFhirServer: !!config.output.api.fhirServerBase,
    hasDriveConfig: !!config.output.drive.folderId,
    recipient: config.recipient,
    orgName: config.organization?.name || null,
    orgId: config.organization?.id || null,
  });
});

// Legacy OAuth2: Start Google Drive authorization
app.get('/auth/google', (req, res) => {
  const oauth2 = getOAuth2Client(config);
  if (!oauth2) {
    return res.status(500).send('Google OAuth2 not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  }

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive.file'],
  });

  res.redirect(authUrl);
});

// OAuth2: Callback after Google authorization (handles both legacy and per-org)
app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) {
    return res.status(400).send('No authorization code received.');
  }

  const oauth2 = getOAuth2Client(config);
  if (!oauth2) {
    return res.status(500).send('Google OAuth2 not configured.');
  }

  // Parse state to check if this is a per-org OAuth flow
  let orgSlug = null;
  let orgId = null;
  if (state) {
    try {
      const parsed = JSON.parse(state);
      orgSlug = parsed.slug;
      orgId = parsed.orgId;
    } catch {}
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      const backUrl = orgSlug ? `/${orgSlug}/admin` : '/';
      return res.send(`
        <html><body style="font-family: Inter, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
          <h2 style="color: #e31c3d;">No Refresh Token Received</h2>
          <p>Google did not return a refresh token. This usually means you've already authorized this app before.</p>
          <p>To fix this: go to <a href="https://myaccount.google.com/permissions">Google Account Permissions</a>,
          remove "Kill the Clipboard", then try connecting again.</p>
          <a href="${backUrl}">Go back</a>
        </body></html>
      `);
    }

    // Per-org flow: save refresh token to database
    if (orgSlug && orgId) {
      updateOrgSettings(orgId, { drive_refresh_token: refreshToken });

      return res.send(`
        <html><body style="font-family: Inter, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
          <h2 style="color: #2e8540;">Google Drive Connected!</h2>
          <p>Your organization's Google Drive has been connected successfully.</p>
          <p>You can now configure the Drive folder in your admin settings.</p>
          <a href="/${orgSlug}/admin" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#0071bc;color:#fff;border-radius:4px;text-decoration:none;font-weight:600;">Back to Admin Settings</a>
        </body></html>
      `);
    }

    // Legacy flow: show flyctl command
    res.send(`
      <html><body style="font-family: Inter, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2 style="color: #2e8540;">Google Drive Connected!</h2>
        <p>Your refresh token has been generated. Run this command to save it to your deployment:</p>
        <pre style="background: #f1f1f1; padding: 16px; border-radius: 4px; overflow-x: auto; font-size: 0.85rem;">flyctl secrets set GOOGLE_REFRESH_TOKEN="${refreshToken}"</pre>
        <p style="margin-top: 16px;">After running that command, the app will automatically upload scanned data to your Google Drive folder.</p>
        <a href="/">Back to scanner</a>
      </body></html>
    `);
  } catch (err) {
    const backUrl = orgSlug ? `/${orgSlug}/admin` : '/';
    res.status(500).send(`
      <html><body style="font-family: Inter, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2 style="color: #e31c3d;">Authorization Failed</h2>
        <p>${err.message}</p>
        <a href="${backUrl}">Go back</a>
      </body></html>
    `);
  }
});

// Legacy: Check Google Drive connection status
app.get('/api/drive-status', (req, res) => {
  const hasOAuth = !!(config.output.drive.clientId && config.output.drive.clientSecret);
  const hasRefreshToken = !!config.output.drive.refreshToken;
  const hasServiceAccount = !!config.output.drive.serviceAccountKey;
  const hasFolderId = !!config.output.drive.folderId;

  res.json({
    configured: (hasRefreshToken || hasServiceAccount) && hasFolderId,
    needsAuth: hasOAuth && !hasRefreshToken && !hasServiceAccount,
    hasFolderId,
    authMethod: hasRefreshToken ? 'oauth2' : hasServiceAccount ? 'service_account' : 'none',
  });
});

// ══════════════════════════════════════════════════════════════════
//  MULTI-TENANT ROUTES — per-org database-backed
// ══════════════════════════════════════════════════════════════════

// Register a new organization
app.post('/api/orgs', async (req, res) => {
  const { slug, name, adminPassword, staffPassword } = req.body;

  if (!slug || !name || !adminPassword || !staffPassword) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  if (!/^[a-z][a-z0-9-]{2,49}$/.test(slug)) {
    return res.status(400).json({ error: 'Slug must be 3-50 characters, lowercase letters/numbers/hyphens, starting with a letter.' });
  }

  if (RESERVED_SLUGS.includes(slug)) {
    return res.status(400).json({ error: 'That URL is reserved.' });
  }

  if (slugExists(slug)) {
    return res.status(409).json({ error: 'That URL is already taken.' });
  }

  if (adminPassword.length < 8) {
    return res.status(400).json({ error: 'Admin password must be at least 8 characters.' });
  }

  if (staffPassword.length < 4) {
    return res.status(400).json({ error: 'Staff password must be at least 4 characters.' });
  }

  try {
    const adminHash = await hashPassword(adminPassword);
    const staffHash = await hashPassword(staffPassword);

    const org = createOrg({
      id: randomUUID(),
      slug,
      name,
      adminPasswordHash: adminHash,
      staffPasswordHash: staffHash,
    });

    const token = createToken({ slug: org.slug, role: 'admin', orgId: org.id });
    res.status(201).json({ slug: org.slug, token });
  } catch (err) {
    console.error('Org creation failed:', err.message);
    res.status(500).json({ error: 'Failed to create organization.' });
  }
});

// Check slug availability
app.get('/api/orgs/check-slug', (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.json({ available: false });

  if (RESERVED_SLUGS.includes(slug)) return res.json({ available: false });
  if (!/^[a-z][a-z0-9-]{2,49}$/.test(slug)) return res.json({ available: false });

  res.json({ available: !slugExists(slug) });
});

// Authenticate as admin or staff
app.post('/api/orgs/:slug/auth', async (req, res) => {
  const { password, role } = req.body;
  const org = getOrgBySlug(req.params.slug);

  if (!org) return res.status(404).json({ error: 'Organization not found.' });
  if (!password) return res.status(400).json({ error: 'Password required.' });
  if (!['admin', 'staff'].includes(role)) {
    return res.status(400).json({ error: 'Role must be admin or staff.' });
  }

  const hash = role === 'admin' ? org.admin_password_hash : org.staff_password_hash;
  const valid = await verifyPassword(password, hash);

  if (!valid) return res.status(401).json({ error: 'Invalid password.' });

  const token = createToken({ slug: org.slug, role, orgId: org.id });
  res.json({ token, role, slug: org.slug, orgName: org.name });
});

// Public org config (no auth needed)
app.get('/api/orgs/:slug/config', (req, res) => {
  const org = getOrgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: 'Organization not found.' });

  res.json({
    name: org.name,
    slug: org.slug,
    storageType: org.storage_type,
    saveFormat: org.save_format || 'both',
    hasDrive: !!org.drive_refresh_token,
    hasOnedrive: !!org.onedrive_refresh_token,
    hasBox: !!org.box_refresh_token,
    hasApi: !!org.api_url,
    hasEmail: !!org.email_to,
  });
});

// Get full settings (admin only)
app.get('/api/orgs/:slug/settings', authMiddleware('admin'), (req, res) => {
  const org = getOrgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: 'Organization not found.' });

  res.json({
    name: org.name,
    slug: org.slug,
    storageType: org.storage_type,
    saveFormat: org.save_format || 'both',
    driveFolderId: org.drive_folder_id || null,
    hasDriveToken: !!org.drive_refresh_token,
    hasOnedriveToken: !!org.onedrive_refresh_token,
    onedriveFolderPath: org.onedrive_folder_path || null,
    hasBoxToken: !!org.box_refresh_token,
    boxFolderId: org.box_folder_id || null,
    apiUrl: org.api_url || null,
    apiHeaders: org.api_headers ? JSON.parse(org.api_headers) : {},
    emailTo: org.email_to || null,
  });
});

// Update settings (admin only)
app.put('/api/orgs/:slug/settings', authMiddleware('admin'), (req, res) => {
  const org = getOrgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: 'Organization not found.' });

  const { storageType, saveFormat, driveFolderId, apiUrl, apiHeaders, emailTo, onedriveFolderPath, boxFolderId } = req.body;
  const updates = {};

  if (storageType && ['download', 'drive', 'onedrive', 'box', 'api', 'email'].includes(storageType)) {
    updates.storage_type = storageType;
  }
  if (saveFormat && ['pdf', 'fhir', 'both'].includes(saveFormat)) {
    updates.save_format = saveFormat;
  }
  if (driveFolderId !== undefined) updates.drive_folder_id = driveFolderId;
  if (onedriveFolderPath !== undefined) updates.onedrive_folder_path = onedriveFolderPath;
  if (boxFolderId !== undefined) updates.box_folder_id = boxFolderId;
  if (apiUrl !== undefined) updates.api_url = apiUrl;
  if (apiHeaders !== undefined) updates.api_headers = JSON.stringify(apiHeaders);
  if (emailTo !== undefined) updates.email_to = emailTo;

  updateOrgSettings(org.id, updates);
  res.json({ ok: true });
});

// Change passwords (admin only)
app.put('/api/orgs/:slug/passwords', authMiddleware('admin'), async (req, res) => {
  const { currentAdminPassword, newAdminPassword, newStaffPassword } = req.body;
  const org = getOrgBySlug(req.params.slug);

  if (!org) return res.status(404).json({ error: 'Organization not found.' });

  const valid = await verifyPassword(currentAdminPassword, org.admin_password_hash);
  if (!valid) return res.status(401).json({ error: 'Current admin password is incorrect.' });

  const updates = {};
  if (newAdminPassword) {
    if (newAdminPassword.length < 8) return res.status(400).json({ error: 'Admin password must be at least 8 characters.' });
    updates.admin_password_hash = await hashPassword(newAdminPassword);
  }
  if (newStaffPassword) {
    if (newStaffPassword.length < 4) return res.status(400).json({ error: 'Staff password must be at least 4 characters.' });
    updates.staff_password_hash = await hashPassword(newStaffPassword);
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No new passwords provided.' });
  }

  updateOrgSettings(org.id, updates);
  res.json({ ok: true });
});

// Test storage connectivity (admin only)
app.post('/api/orgs/:slug/test-connection', authMiddleware('admin'), async (req, res) => {
  const org = getOrgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: 'Organization not found.' });

  const { storageType } = req.body;

  try {
    if (storageType === 'drive' || storageType === 'google_drive') {
      if (!org.drive_refresh_token) {
        return res.json({ ok: false, error: 'Google Drive not connected. Please connect your Drive account first.' });
      }
      // Test Drive access by listing files in the folder
      const { google } = await import('googleapis');
      const oauth2 = new google.auth.OAuth2(
        config.output.drive.clientId,
        config.output.drive.clientSecret
      );
      oauth2.setCredentials({ refresh_token: org.drive_refresh_token });
      const drive = google.drive({ version: 'v3', auth: oauth2 });

      const folderId = parseFolderId(org.drive_folder_id);
      if (!folderId) {
        return res.json({ ok: false, error: 'No Drive folder configured. Enter a folder URL.' });
      }

      // Try to list folder contents as a permissions check
      await drive.files.list({
        q: `'${folderId}' in parents`,
        pageSize: 1,
        fields: 'files(id)',
      });

      return res.json({ ok: true, message: 'Google Drive connected and folder accessible.' });
    }

    if (storageType === 'api') {
      const apiUrl = org.api_url;
      if (!apiUrl) return res.json({ ok: false, error: 'No API URL configured.' });

      const headers = org.api_headers ? JSON.parse(org.api_headers) : {};
      const testResp = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ test: true, source: 'kill-the-clipboard', timestamp: new Date().toISOString() }),
        signal: AbortSignal.timeout(10000),
      });

      if (testResp.ok) {
        return res.json({ ok: true, message: `API endpoint responded (${testResp.status}).` });
      } else {
        return res.json({ ok: false, error: `API endpoint returned ${testResp.status}.` });
      }
    }

    if (storageType === 'email') {
      if (!org.email_to) return res.json({ ok: false, error: 'No email recipient configured.' });
      if (!process.env.SMTP_HOST) return res.json({ ok: false, error: 'SMTP not configured by system administrator.' });

      // Test SMTP connection
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.default.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT, 10) || 587,
        secure: parseInt(process.env.SMTP_PORT, 10) === 465,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      await transporter.verify();
      return res.json({ ok: true, message: 'SMTP connection verified.' });
    }

    if (storageType === 'onedrive') {
      if (!org.onedrive_refresh_token) {
        return res.json({ ok: false, error: 'OneDrive not connected. Please connect your OneDrive account first.' });
      }
      // Test by getting user's drive info
      try {
        const { uploadToOnedrive: _unused, ...mod } = await import('./src/output/onedrive-uploader.js');
        // Simple test: try to get access token (which verifies the refresh token)
        const testResp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.ONEDRIVE_CLIENT_ID,
            client_secret: process.env.ONEDRIVE_CLIENT_SECRET,
            refresh_token: org.onedrive_refresh_token,
            grant_type: 'refresh_token',
            scope: 'Files.ReadWrite.All offline_access',
          }).toString(),
        });
        if (testResp.ok) {
          return res.json({ ok: true, message: 'OneDrive connected and accessible.' });
        } else {
          return res.json({ ok: false, error: 'OneDrive token may be expired. Try reconnecting.' });
        }
      } catch (err) {
        return res.json({ ok: false, error: err.message });
      }
    }

    if (storageType === 'box') {
      if (!org.box_refresh_token) {
        return res.json({ ok: false, error: 'Box not connected. Please connect your Box account first.' });
      }
      if (!org.box_folder_id) {
        return res.json({ ok: false, error: 'No Box folder ID configured.' });
      }
      // Test by refreshing token
      try {
        const testResp = await fetch('https://api.box.com/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.BOX_CLIENT_ID,
            client_secret: process.env.BOX_CLIENT_SECRET,
            refresh_token: org.box_refresh_token,
            grant_type: 'refresh_token',
          }).toString(),
        });
        if (testResp.ok) {
          // Save new refresh token (Box rotates them)
          const tokens = await testResp.json();
          if (tokens.refresh_token) {
            updateOrgSettings(org.id, { box_refresh_token: tokens.refresh_token });
          }
          return res.json({ ok: true, message: 'Box connected and accessible.' });
        } else {
          return res.json({ ok: false, error: 'Box token may be expired. Try reconnecting.' });
        }
      } catch (err) {
        return res.json({ ok: false, error: err.message });
      }
    }

    if (storageType === 'download') {
      return res.json({ ok: true, message: 'Direct download requires no server connectivity.' });
    }

    return res.json({ ok: false, error: 'Unknown storage type.' });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

// Per-org Drive OAuth connect (admin must be logged in via UI)
app.get('/api/orgs/:slug/drive-connect', (req, res) => {
  const org = getOrgBySlug(req.params.slug);
  if (!org) return res.status(404).send('Organization not found.');

  const oauth2 = getOAuth2Client(config);
  if (!oauth2) return res.status(500).send('Google OAuth2 not configured. Contact the system administrator.');

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive.file'],
    state: JSON.stringify({ slug: org.slug, orgId: org.id }),
  });

  res.redirect(authUrl);
});

// Per-org OneDrive OAuth connect
app.get('/api/orgs/:slug/onedrive-connect', (req, res) => {
  const org = getOrgBySlug(req.params.slug);
  if (!org) return res.status(404).send('Organization not found.');

  const publicUrl = config.server.publicUrl || `http://localhost:${PORT}`;
  const redirectUri = `${publicUrl}/auth/onedrive/callback`;
  const state = JSON.stringify({ slug: org.slug, orgId: org.id });

  const authUrl = getOnedriveAuthUrl(redirectUri, state);
  if (!authUrl) return res.status(500).send('OneDrive not configured. Set ONEDRIVE_CLIENT_ID env var.');

  res.redirect(authUrl);
});

// OneDrive OAuth callback
app.get('/auth/onedrive/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('No authorization code received.');

  let orgSlug = null, orgId = null;
  if (state) {
    try { const p = JSON.parse(state); orgSlug = p.slug; orgId = p.orgId; } catch {}
  }

  try {
    const publicUrl = config.server.publicUrl || `http://localhost:${PORT}`;
    const redirectUri = `${publicUrl}/auth/onedrive/callback`;
    const tokens = await exchangeOnedriveCode(code, redirectUri);

    if (orgId && tokens.refresh_token) {
      updateOrgSettings(orgId, { onedrive_refresh_token: tokens.refresh_token });
    }

    const backUrl = orgSlug ? `/${orgSlug}/admin` : '/';
    res.send(`
      <html><body style="font-family: Inter, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2 style="color: #2e8540;">OneDrive Connected!</h2>
        <p>Your organization's OneDrive has been connected successfully.</p>
        <a href="${backUrl}" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#0071bc;color:#fff;border-radius:4px;text-decoration:none;font-weight:600;">Back to Admin Settings</a>
      </body></html>
    `);
  } catch (err) {
    const backUrl = orgSlug ? `/${orgSlug}/admin` : '/';
    res.status(500).send(`
      <html><body style="font-family: Inter, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2 style="color: #e31c3d;">OneDrive Authorization Failed</h2>
        <p>${err.message}</p>
        <a href="${backUrl}">Go back</a>
      </body></html>
    `);
  }
});

// Per-org Box OAuth connect
app.get('/api/orgs/:slug/box-connect', (req, res) => {
  const org = getOrgBySlug(req.params.slug);
  if (!org) return res.status(404).send('Organization not found.');

  const publicUrl = config.server.publicUrl || `http://localhost:${PORT}`;
  const redirectUri = `${publicUrl}/auth/box/callback`;
  const state = JSON.stringify({ slug: org.slug, orgId: org.id });

  const authUrl = getBoxAuthUrl(redirectUri, state);
  if (!authUrl) return res.status(500).send('Box not configured. Set BOX_CLIENT_ID env var.');

  res.redirect(authUrl);
});

// Box OAuth callback
app.get('/auth/box/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('No authorization code received.');

  let orgSlug = null, orgId = null;
  if (state) {
    try { const p = JSON.parse(state); orgSlug = p.slug; orgId = p.orgId; } catch {}
  }

  try {
    const publicUrl = config.server.publicUrl || `http://localhost:${PORT}`;
    const redirectUri = `${publicUrl}/auth/box/callback`;
    const tokens = await exchangeBoxCode(code, redirectUri);

    if (orgId && tokens.refresh_token) {
      updateOrgSettings(orgId, { box_refresh_token: tokens.refresh_token });
    }

    const backUrl = orgSlug ? `/${orgSlug}/admin` : '/';
    res.send(`
      <html><body style="font-family: Inter, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2 style="color: #2e8540;">Box Connected!</h2>
        <p>Your organization's Box has been connected successfully.</p>
        <a href="${backUrl}" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#0071bc;color:#fff;border-radius:4px;text-decoration:none;font-weight:600;">Back to Admin Settings</a>
      </body></html>
    `);
  } catch (err) {
    const backUrl = orgSlug ? `/${orgSlug}/admin` : '/';
    res.status(500).send(`
      <html><body style="font-family: Inter, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2 style="color: #e31c3d;">Box Authorization Failed</h2>
        <p>${err.message}</p>
        <a href="${backUrl}">Go back</a>
      </body></html>
    `);
  }
});

// Per-org scan (staff or admin auth required)
app.post('/api/orgs/:slug/scan', authMiddleware('staff'), async (req, res) => {
  const { qrText, passcode } = req.body;
  const org = getOrgBySlug(req.params.slug);

  if (!org) return res.status(404).json({ error: 'Organization not found.' });
  if (!qrText) return res.status(400).json({ error: 'No QR text provided.' });

  let shlPayload;
  try {
    shlPayload = parseShlUri(qrText);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!shlPayload) {
    return res.json({ status: 'not_shl', message: 'QR code does not contain a SMART Health Link.' });
  }

  if (shlPayload.flag.includes('P') && !passcode) {
    return res.json({ status: 'need_passcode', label: shlPayload.label });
  }

  try {
    const manifest = await fetchManifest(shlPayload, {
      recipient: org.name || config.recipient,
      passcode,
    });

    const results = await extractHealthData(manifest, shlPayload.key, {
      maxDecompressedSize: config.processing?.maxDecompressedSize,
    });

    // Validate FHIR data
    if (results.fhirBundles.length > 0) {
      const validation = validateFhirBundles(results.fhirBundles);
      if (!validation.valid) {
        return res.json({
          status: 'validation_failed',
          error: `Invalid FHIR data: ${validation.errors.join('; ')}`,
          label: shlPayload.label,
        });
      }
    }

    // Reject scans with no usable data
    if (results.fhirBundles.length === 0 && results.pdfs.length === 0) {
      return res.json({
        status: 'validation_failed',
        error: 'No valid FHIR bundles or PDF documents found in the scanned data.',
        label: shlPayload.label,
      });
    }

    // Filter results based on org's save format preference
    const saveFormat = org.save_format || 'both';
    const filteredResults = {
      fhirBundles: saveFormat === 'pdf' ? [] : results.fhirBundles,
      pdfs: saveFormat === 'fhir' ? [] : results.pdfs,
      raw: results.raw,
    };

    // Route output based on org's storage type
    let driveLink = null;
    let driveError = null;
    let onedriveLink = null;
    let onedriveError = null;
    let boxLink = null;
    let boxError = null;
    let emailSent = false;
    let emailError = null;
    let apiPosted = false;
    let apiError = null;

    if (org.storage_type === 'drive' && org.drive_refresh_token) {
      try {
        const driveConfig = {
          folderId: org.drive_folder_id,
          clientId: config.output.drive.clientId,
          clientSecret: config.output.drive.clientSecret,
          refreshToken: org.drive_refresh_token,
        };
        const driveSummary = await uploadToDrive(filteredResults, driveConfig, { verbose: false });
        driveLink = driveSummary.driveFolder;
      } catch (err) {
        driveError = err.message;
        console.error(`[${org.slug}] Drive upload failed: ${err.message}`);
      }
    }

    if (org.storage_type === 'api' && org.api_url) {
      try {
        const apiConfig = {
          url: org.api_url,
          headers: org.api_headers ? JSON.parse(org.api_headers) : {},
        };
        await postToApi(filteredResults, apiConfig, { verbose: false });
        apiPosted = true;
      } catch (err) {
        apiError = err.message;
        console.error(`[${org.slug}] API post failed: ${err.message}`);
      }
    }

    if (org.storage_type === 'email' && org.email_to) {
      try {
        const emailConfig = {
          to: org.email_to,
          smtp: {
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT || 587,
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
            from: process.env.SMTP_FROM || 'Kill the Clipboard <noreply@killtheclipboard.fly.dev>',
          },
        };
        await sendEmail(filteredResults, emailConfig, { verbose: false });
        emailSent = true;
      } catch (err) {
        emailError = err.message;
        console.error(`[${org.slug}] Email send failed: ${err.message}`);
      }
    }

    if (org.storage_type === 'onedrive' && org.onedrive_refresh_token) {
      try {
        const odConfig = {
          refreshToken: org.onedrive_refresh_token,
          folderPath: org.onedrive_folder_path || '/KillTheClipboard',
        };
        const odSummary = await uploadToOnedrive(filteredResults, odConfig, { verbose: false });
        onedriveLink = odSummary.folderLink;
      } catch (err) {
        onedriveError = err.message;
        console.error(`[${org.slug}] OneDrive upload failed: ${err.message}`);
      }
    }

    if (org.storage_type === 'box' && org.box_refresh_token) {
      try {
        const boxConfig = {
          refreshToken: org.box_refresh_token,
          folderId: org.box_folder_id,
        };
        const boxSummary = await uploadToBox(filteredResults, boxConfig, { verbose: false });
        boxLink = boxSummary.folderLink;
        // Box rotates refresh tokens — save the new one
        if (boxSummary.newRefreshToken) {
          updateOrgSettings(org.id, { box_refresh_token: boxSummary.newRefreshToken });
        }
      } catch (err) {
        boxError = err.message;
        console.error(`[${org.slug}] Box upload failed: ${err.message}`);
      }
    }

    const response = {
      status: 'success',
      label: shlPayload.label,
      storageType: org.storage_type,
      saveFormat,
      driveLink,
      driveError,
      onedriveLink,
      onedriveError,
      boxLink,
      boxError,
      emailSent,
      emailError,
      apiPosted,
      apiError,
      summary: {
        fhirBundles: filteredResults.fhirBundles.length,
        pdfs: filteredResults.pdfs.length,
        rawEntries: filteredResults.raw.length,
      },
      fhirBundles: filteredResults.fhirBundles,
      pdfs: filteredResults.pdfs.map((p) => ({
        filename: p.filename,
        hasData: !!p.data,
        dataBase64: p.data ? p.data.toString('base64') : null,
        url: p.url || null,
      })),
    };

    res.json(response);
  } catch (err) {
    console.error(`[${org.slug}] Scan error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  DYNAMIC PAGE ROUTES (must come LAST — catch-all slug patterns)
// ══════════════════════════════════════════════════════════════════

// Per-org admin settings page
app.get('/:slug/admin', (req, res) => {
  const org = getOrgBySlug(req.params.slug);
  if (!org) return res.status(404).sendFile(join(__dirname, 'public', 'landing.html'));
  res.sendFile(join(__dirname, 'public', 'admin.html'));
});

// Per-org scanner page
app.get('/:slug', (req, res) => {
  const org = getOrgBySlug(req.params.slug);
  if (!org) return res.status(404).sendFile(join(__dirname, 'public', 'landing.html'));
  res.sendFile(join(__dirname, 'public', 'scanner.html'));
});

// ══════════════════════════════════════════════════════════════════
//  STARTUP
// ══════════════════════════════════════════════════════════════════

function getLocalIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

// Initialize database before starting server
initDb();

app.listen(PORT, HOST, () => {
  const localIp = getLocalIp();
  const org = config.organization?.name || 'Kill the Clipboard';

  console.log(`\n  ${org}`);
  console.log(`  ${'='.repeat(org.length)}\n`);
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  http://${localIp}:${PORT}   <-- use this on your phone\n`);
  console.log(`  Output:   ${config.output.mode} -> ${config.output.directory}`);
  if (config.output.api.url) console.log(`  API:      ${config.output.api.url}`);
  if (config.output.api.fhirServerBase) console.log(`  FHIR:     ${config.output.api.fhirServerBase}`);
  if (config.output.drive.folderId) console.log(`  Drive:    folder ${config.output.drive.folderId}`);
  console.log(`  Database: initialized`);
  console.log(`  Multi-tenant: enabled at /:slug\n`);
});
