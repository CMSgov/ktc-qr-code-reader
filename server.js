import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomUUID, timingSafeEqual } from 'node:crypto';
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
import { sendViaGmail, getGmailAuthUrl, exchangeGmailCode, getGmailUserEmail } from './src/output/gmail-sender.js';
import { sendViaOutlook, getOutlookMailAuthUrl, exchangeOutlookMailCode, getOutlookUserEmail } from './src/output/outlook-sender.js';
import { initDb, getDb, createOrg, getOrgBySlug, getOrgById, updateOrgSettings, slugExists, listAllOrgs, deleteOrgById, countOrgs, createApprovalRequest, listApprovalRequests, updateApprovalRequest, getDecryptedToken, prepareTokenForStorage, logAuditEvent, listAuditLog, listAllAuditLog } from './src/db.js';
import { hashPassword, verifyPassword, createToken, authMiddleware } from './src/auth.js';
import { readFileSync } from 'node:fs';
import rateLimit from 'express-rate-limit';

// Load version from package.json at startup
const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf-8'));
const APP_VERSION = pkg.version;

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const config = loadConfig();

const PORT = process.env.PORT || config.server?.port || 3000;
const HOST = process.env.HOST || config.server?.host || '0.0.0.0';

const RESERVED_SLUGS = ['register', 'admin', 'api', 'auth', 'public', 'static', 'assets', 'health', 'index.html', 'privacy', 'terms', 'super-admin', 'setup-guide', 'test-qr-codes'];

// ── CMS Health Tech Ecosystem — Kill the Clipboard Approved Apps ──
const APPROVED_APPS = [
  // Early Adopters (12)
  { appId: 'apple', name: 'Apple', tier: 'early-adopter' },
  { appId: 'bwell', name: 'b.well Connected Health', tier: 'early-adopter' },
  { appId: 'citizen-health', name: 'Citizen Health', tier: 'early-adopter' },
  { appId: 'cvs-health', name: 'CVS Health', tier: 'early-adopter' },
  { appId: 'fasten-health', name: 'Fasten Health', tier: 'early-adopter' },
  { appId: 'flexpa', name: 'Flexpa', tier: 'early-adopter' },
  { appId: 'google', name: 'Google', tier: 'early-adopter' },
  { appId: 'nanthealth', name: 'NantHealth', tier: 'early-adopter' },
  { appId: 'samsung', name: 'Samsung', tier: 'early-adopter' },
  { appId: 'sharecare', name: 'Sharecare', tier: 'early-adopter' },
  { appId: 'unitedhealth-group', name: 'UnitedHealth Group', tier: 'early-adopter' },
  { appId: 'zocdoc', name: 'Zocdoc', tier: 'early-adopter' },
  // Pledgees (71)
  { appId: '1kosmos', name: '1Kosmos', tier: 'pledgee' },
  { appId: 'actuvi', name: 'Actuvi LLC', tier: 'pledgee' },
  { appId: 'andor-health', name: 'Andor Health', tier: 'pledgee' },
  { appId: 'andromeda-health', name: 'Andromeda Health Corp', tier: 'pledgee' },
  { appId: 'capital-rx', name: 'Capital Rx Inc.', tier: 'pledgee' },
  { appId: 'coco-health', name: 'Coco Health', tier: 'pledgee' },
  { appId: 'coligomed', name: 'ColigoMed', tier: 'pledgee' },
  { appId: 'connxus', name: 'Connxus', tier: 'pledgee' },
  { appId: 'credibl', name: 'Credibl', tier: 'pledgee' },
  { appId: 'cuezen', name: 'CueZen Inc.', tier: 'pledgee' },
  { appId: 'cyrencare', name: 'CyrenCare', tier: 'pledgee' },
  { appId: 'docusign', name: 'Docusign', tier: 'pledgee' },
  { appId: 'edwin-health', name: 'Edwin Health', tier: 'pledgee' },
  { appId: 'es-digital-health', name: 'ES Digital Health', tier: 'pledgee' },
  { appId: 'evisit', name: 'eVisit', tier: 'pledgee' },
  { appId: 'exammed', name: 'ExamMed LLC', tier: 'pledgee' },
  { appId: 'fabric', name: 'Fabric', tier: 'pledgee' },
  { appId: 'fawkes-biodata', name: 'Fawkes Biodata', tier: 'pledgee' },
  { appId: 'flagler-health', name: 'Flagler Health', tier: 'pledgee' },
  { appId: 'formdr', name: 'FormDr', tier: 'pledgee' },
  { appId: 'genoplex', name: 'Genoplex', tier: 'pledgee' },
  { appId: 'goodrx', name: 'GoodRx', tier: 'pledgee' },
  { appId: 'guava-health', name: 'Guava Health', tier: 'pledgee' },
  { appId: 'haau3', name: 'haau3', tier: 'pledgee' },
  { appId: 'health-bank-one', name: 'Health Bank One Inc.', tier: 'pledgee' },
  { appId: 'health-note', name: 'Health Note', tier: 'pledgee' },
  { appId: 'healthbookplus', name: 'HealthBook+', tier: 'pledgee' },
  { appId: 'healthex', name: 'HealthEx', tier: 'pledgee' },
  { appId: 'healthhive', name: 'HealthHive', tier: 'pledgee' },
  { appId: 'healthtree', name: 'HealthTree Foundation', tier: 'pledgee' },
  { appId: 'healthy-insights', name: 'Healthy Insights Inc.', tier: 'pledgee' },
  { appId: 'healthyr', name: 'Healthyr', tier: 'pledgee' },
  { appId: 'humetrix', name: 'Humetrix Health', tier: 'pledgee' },
  { appId: 'imprivata', name: 'Imprivata Inc.', tier: 'pledgee' },
  { appId: 'inpursuit-health', name: 'InPursuit Health LLC', tier: 'pledgee' },
  { appId: 'intelichart', name: 'InteliChart', tier: 'pledgee' },
  { appId: 'january-ai', name: 'January AI', tier: 'pledgee' },
  { appId: 'jeeva-ai', name: 'Jeeva AI Health Systems LLC', tier: 'pledgee' },
  { appId: 'kintsugi', name: 'Kintsugi Mindful Wellness', tier: 'pledgee' },
  { appId: 'login-health', name: 'Login.Health', tier: 'pledgee' },
  { appId: 'luma-health', name: 'Luma Health', tier: 'pledgee' },
  { appId: 'lymeless', name: 'LymeLess Health', tier: 'pledgee' },
  { appId: 'magical', name: 'Magical', tier: 'pledgee' },
  { appId: 'marsha-health', name: 'MARSHA Health', tier: 'pledgee' },
  { appId: 'massive-bio', name: 'Massive Bio Inc.', tier: 'pledgee' },
  { appId: 'mhdg', name: 'Medical Home Development Group', tier: 'pledgee' },
  { appId: 'medicasoft', name: 'MedicaSoft', tier: 'pledgee' },
  { appId: 'medthread', name: 'MedThread', tier: 'pledgee' },
  { appId: 'mihin', name: 'MiHIN', tier: 'pledgee' },
  { appId: 'miracural', name: 'Miracural AI', tier: 'pledgee' },
  { appId: 'nourish', name: 'Nourish', tier: 'pledgee' },
  { appId: 'orion-health', name: 'Orion Health', tier: 'pledgee' },
  { appId: 'otis-health', name: 'Otis Health', tier: 'pledgee' },
  { appId: 'patient-centric', name: 'Patient Centric Solutions', tier: 'pledgee' },
  { appId: 'patient-com', name: 'Patient.com', tier: 'pledgee' },
  { appId: 'patientory', name: 'Patientory Inc.', tier: 'pledgee' },
  { appId: 'pfps-us', name: 'Patients for Patient Safety US', tier: 'pledgee' },
  { appId: 'penn-medicine', name: 'Penn Medicine', tier: 'pledgee' },
  { appId: 'phreesia', name: 'Phreesia', tier: 'pledgee' },
  { appId: 'primary-record', name: 'Primary Record', tier: 'pledgee' },
  { appId: 'pulsar-health', name: 'Pulsar Health Inc', tier: 'pledgee' },
  { appId: 'seqster', name: 'SEQSTER', tier: 'pledgee' },
  { appId: 'sprinter-health', name: 'Sprinter Health', tier: 'pledgee' },
  { appId: 'sync-md', name: 'Sync.MD', tier: 'pledgee' },
  { appId: 'commons-project', name: 'The Commons Project Foundation', tier: 'pledgee' },
  { appId: 'trialcliniq', name: 'TrialClinIQ', tier: 'pledgee' },
  { appId: 'vinyl-health', name: 'Vinyl Health', tier: 'pledgee' },
  { appId: 'wellconnector', name: 'WellConnector', tier: 'pledgee' },
  { appId: 'wellnavigator', name: 'WellNavigator LLC', tier: 'pledgee' },
  { appId: 'xcures', name: 'xCures', tier: 'pledgee' },
  { appId: 'yosi-health', name: 'Yosi Health', tier: 'pledgee' },
];

app.use(express.json({ limit: '10mb' }));

// ── Server-side HTML escaping (for OAuth error pages) ──
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Slug validation (for OAuth state parameters) ──
function isValidSlug(slug) {
  return typeof slug === 'string' && /^[a-z][a-z0-9-]{1,49}$/.test(slug);
}

// ── HMAC-signed OAuth state (CSRF protection) ──
// Prevents attackers from forging state to link their storage to a victim's org.
import { createHmac as _createHmac } from 'node:crypto';

function createSignedOAuthState(slug, orgId) {
  const payload = JSON.stringify({ slug, orgId });
  const secret = process.env.SESSION_SECRET || 'oauth-state-fallback';
  const sig = _createHmac('sha256', secret).update(payload).digest('base64url');
  return JSON.stringify({ slug, orgId, sig });
}

function verifyOAuthState(stateString) {
  if (!stateString) return null;
  try {
    const parsed = JSON.parse(stateString);
    if (!parsed.sig || !parsed.slug) return null;

    const payload = JSON.stringify({ slug: parsed.slug, orgId: parsed.orgId });
    const secret = process.env.SESSION_SECRET || 'oauth-state-fallback';
    const expectedSig = _createHmac('sha256', secret).update(payload).digest('base64url');

    const sigBuf = Buffer.from(parsed.sig);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }

    if (!isValidSlug(parsed.slug)) return null;
    return { slug: parsed.slug, orgId: parsed.orgId };
  } catch {
    return null;
  }
}

// ── Rate Limiting ──
// Protect auth endpoints against brute-force and proxy endpoints against abuse.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                    // 20 attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again later.' },
});

const proxyLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,  // 1 minute
  max: 30,                    // 30 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,                    // 5 registrations per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts. Please try again later.' },
});

// ── Content Security Policy ──
// Mitigates XSS by restricting which scripts, styles, and connections are allowed.
// CDN scripts are pinned to specific versions and verified via Subresource Integrity (SRI) hashes.
// Note: 'unsafe-inline' is required for onclick handlers in HTML; all innerHTML uses escapeHtml().
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "frame-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ── Explicit page routes (before static, so they override index.html default) ──

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'landing.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'register.html'));
});

app.get('/privacy', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'privacy.html'));
});

app.get('/terms', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'terms.html'));
});

app.get('/super-admin', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'super-admin.html'));
});

app.get('/setup-guide', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'setup-guide.html'));
});

app.get('/test-qr-codes', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'test-qr-codes.html'));
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
  // State is HMAC-signed to prevent CSRF — attacker can't forge valid state.
  let orgSlug = null;
  let orgId = null;
  if (state) {
    const verified = verifyOAuthState(state);
    if (verified) { orgSlug = verified.slug; orgId = verified.orgId; }
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      const backUrl = orgSlug ? `/${escapeHtml(orgSlug)}/admin` : '/';
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

    // Per-org flow: save refresh token to database (encrypted at rest)
    if (orgSlug && orgId) {
      updateOrgSettings(orgId, { drive_refresh_token: prepareTokenForStorage(refreshToken, orgId), storage_type: 'drive' });

      return res.send(`
        <html><body style="font-family: Inter, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
          <h2 style="color: #2e8540;">Google Drive Connected!</h2>
          <p>Your organization's Google Drive has been connected successfully.</p>
          <p>You can now configure the Drive folder in your admin settings.</p>
          <a href="/${escapeHtml(orgSlug)}/admin" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#0071bc;color:#fff;border-radius:4px;text-decoration:none;font-weight:600;">Back to Admin Settings</a>
        </body></html>
      `);
    }

    // Legacy flow: show flyctl command (token escaped to prevent HTML breakout)
    res.send(`
      <html><body style="font-family: Inter, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2 style="color: #2e8540;">Google Drive Connected!</h2>
        <p>Your refresh token has been generated. Run this command to save it to your deployment:</p>
        <pre style="background: #f1f1f1; padding: 16px; border-radius: 4px; overflow-x: auto; font-size: 0.85rem;">flyctl secrets set GOOGLE_REFRESH_TOKEN="${escapeHtml(refreshToken)}"</pre>
        <p style="margin-top: 16px;">After running that command, the app will automatically upload scanned data to your Google Drive folder.</p>
        <a href="/">Back to scanner</a>
      </body></html>
    `);
  } catch (err) {
    const backUrl = orgSlug ? `/${escapeHtml(orgSlug)}/admin` : '/';
    res.status(500).send(`
      <html><body style="font-family: Inter, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2 style="color: #e31c3d;">Authorization Failed</h2>
        <p>${escapeHtml(err.message)}</p>
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

// ── App Validation Endpoints ──

// Get approved apps list (public)
app.get('/api/approved-apps', (req, res) => {
  res.json(APPROVED_APPS);
});

// Verify an app by appId (public)
app.get('/api/verify-app', (req, res) => {
  const { appId } = req.query;
  if (!appId) return res.status(400).json({ error: 'appId is required' });

  const app = APPROVED_APPS.find(a => a.appId === appId.toLowerCase());
  if (app) {
    res.json({ approved: true, app });
  } else {
    res.json({ approved: false });
  }
});

// ══════════════════════════════════════════════════════════════════
//  MULTI-TENANT ROUTES — per-org database-backed
// ══════════════════════════════════════════════════════════════════

// Register a new organization
app.post('/api/orgs', registrationLimiter, async (req, res) => {
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
app.post('/api/orgs/:slug/auth', authLimiter, async (req, res) => {
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

  const timeoutMinutes = org.session_timeout_minutes || 720;
  const token = createToken({ slug: org.slug, role, orgId: org.id, timeoutMinutes });
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
    hasGmail: !!org.gmail_refresh_token,
    hasOutlook: !!org.outlook_refresh_token,
    requireAppValidation: !!org.require_app_validation,
    sessionTimeoutMinutes: org.session_timeout_minutes || 720,
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
    hasGmailToken: !!org.gmail_refresh_token,
    gmailEmail: org.gmail_email || null,
    hasOutlookToken: !!org.outlook_refresh_token,
    outlookEmail: org.outlook_email || null,
    requireAppValidation: !!org.require_app_validation,
    sessionTimeoutMinutes: org.session_timeout_minutes || 720,
  });
});

// Update settings (admin only)
app.put('/api/orgs/:slug/settings', authMiddleware('admin'), (req, res) => {
  const org = getOrgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: 'Organization not found.' });

  const { storageType, saveFormat, driveFolderId, apiUrl, apiHeaders, emailTo, onedriveFolderPath, boxFolderId, requireAppValidation, sessionTimeoutMinutes } = req.body;
  const updates = {};

  if (storageType && ['download', 'drive', 'onedrive', 'box', 'api', 'email', 'gmail', 'outlook'].includes(storageType)) {
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
  if (requireAppValidation !== undefined) updates.require_app_validation = requireAppValidation ? 1 : 0;
  if (sessionTimeoutMinutes !== undefined) {
    const validTimeouts = [60, 240, 480, 720, 1440];
    const val = parseInt(sessionTimeoutMinutes);
    if (validTimeouts.includes(val)) updates.session_timeout_minutes = val;
  }

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
      oauth2.setCredentials({ refresh_token: getDecryptedToken(org, 'drive_refresh_token') });
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

    if (storageType === 'gmail') {
      if (!org.gmail_refresh_token) {
        return res.json({ ok: false, error: 'Gmail not connected. Please connect your Gmail account first.' });
      }
      if (!org.email_to) {
        return res.json({ ok: false, error: 'No email recipient configured.' });
      }
      try {
        const testResp = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            refresh_token: getDecryptedToken(org, 'gmail_refresh_token'),
            grant_type: 'refresh_token',
          }).toString(),
        });
        if (testResp.ok) {
          return res.json({ ok: true, message: 'Gmail connected and authorized.' });
        } else {
          return res.json({ ok: false, error: 'Gmail token may be expired. Try reconnecting.' });
        }
      } catch (err) {
        return res.json({ ok: false, error: err.message });
      }
    }

    if (storageType === 'outlook') {
      if (!org.outlook_refresh_token) {
        return res.json({ ok: false, error: 'Outlook not connected. Please connect your Microsoft account first.' });
      }
      if (!org.email_to) {
        return res.json({ ok: false, error: 'No email recipient configured.' });
      }
      try {
        const testResp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.ONEDRIVE_CLIENT_ID,
            client_secret: process.env.ONEDRIVE_CLIENT_SECRET,
            refresh_token: getDecryptedToken(org, 'outlook_refresh_token'),
            grant_type: 'refresh_token',
            scope: 'Mail.Send offline_access',
          }).toString(),
        });
        if (testResp.ok) {
          return res.json({ ok: true, message: 'Outlook email connected and authorized.' });
        } else {
          return res.json({ ok: false, error: 'Outlook token may be expired. Try reconnecting.' });
        }
      } catch (err) {
        return res.json({ ok: false, error: err.message });
      }
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
            refresh_token: getDecryptedToken(org, 'onedrive_refresh_token'),
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
      // Test by refreshing token and verifying folder access
      try {
        const testResp = await fetch('https://api.box.com/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.BOX_CLIENT_ID,
            client_secret: process.env.BOX_CLIENT_SECRET,
            refresh_token: getDecryptedToken(org, 'box_refresh_token'),
            grant_type: 'refresh_token',
          }).toString(),
        });
        if (!testResp.ok) {
          return res.json({ ok: false, error: 'Box token may be expired. Try reconnecting.' });
        }
        const tokens = await testResp.json();
        // Save new refresh token (Box rotates them on every use — encrypt before storing)
        if (tokens.refresh_token) {
          updateOrgSettings(org.id, { box_refresh_token: prepareTokenForStorage(tokens.refresh_token, org.id) });
        }
        // Verify folder access
        const folderResp = await fetch(`https://api.box.com/2.0/folders/${org.box_folder_id}`, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (folderResp.ok) {
          return res.json({ ok: true, message: 'Box connected and folder accessible.' });
        } else {
          return res.json({ ok: false, error: `Box folder "${org.box_folder_id}" not found. Use "0" for root folder, or enter a valid folder ID from your Box URL.` });
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
    state: createSignedOAuthState(org.slug, org.id),
  });

  res.redirect(authUrl);
});

// Per-org OneDrive OAuth connect
app.get('/api/orgs/:slug/onedrive-connect', (req, res) => {
  const org = getOrgBySlug(req.params.slug);
  if (!org) return res.status(404).send('Organization not found.');

  const publicUrl = config.server.publicUrl || `http://localhost:${PORT}`;
  const redirectUri = `${publicUrl}/auth/onedrive/callback`;
  const state = createSignedOAuthState(org.slug, org.id);

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
    const verified = verifyOAuthState(state);
    if (verified) { orgSlug = verified.slug; orgId = verified.orgId; }
  }

  try {
    const publicUrl = config.server.publicUrl || `http://localhost:${PORT}`;
    const redirectUri = `${publicUrl}/auth/onedrive/callback`;
    const tokens = await exchangeOnedriveCode(code, redirectUri);

    if (orgId && tokens.refresh_token) {
      updateOrgSettings(orgId, { onedrive_refresh_token: prepareTokenForStorage(tokens.refresh_token, orgId), storage_type: 'onedrive' });
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
    const backUrl = orgSlug ? `/${escapeHtml(orgSlug)}/admin` : '/';
    res.status(500).send(`
      <html><body style="font-family: Inter, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2 style="color: #e31c3d;">OneDrive Authorization Failed</h2>
        <p>${escapeHtml(err.message)}</p>
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
  const state = createSignedOAuthState(org.slug, org.id);

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
    const verified = verifyOAuthState(state);
    if (verified) { orgSlug = verified.slug; orgId = verified.orgId; }
  }

  try {
    const publicUrl = config.server.publicUrl || `http://localhost:${PORT}`;
    const redirectUri = `${publicUrl}/auth/box/callback`;
    const tokens = await exchangeBoxCode(code, redirectUri);

    if (orgId && tokens.refresh_token) {
      updateOrgSettings(orgId, { box_refresh_token: prepareTokenForStorage(tokens.refresh_token, orgId), storage_type: 'box' });
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
    const backUrl = orgSlug ? `/${escapeHtml(orgSlug)}/admin` : '/';
    res.status(500).send(`
      <html><body style="font-family: Inter, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2 style="color: #e31c3d;">Box Authorization Failed</h2>
        <p>${escapeHtml(err.message)}</p>
        <a href="${backUrl}">Go back</a>
      </body></html>
    `);
  }
});

// Per-org Gmail OAuth connect
app.get('/api/orgs/:slug/gmail-connect', (req, res) => {
  const org = getOrgBySlug(req.params.slug);
  if (!org) return res.status(404).send('Organization not found.');

  const publicUrl = config.server.publicUrl || `http://localhost:${PORT}`;
  const redirectUri = `${publicUrl}/auth/gmail/callback`;
  const state = createSignedOAuthState(org.slug, org.id);

  const authUrl = getGmailAuthUrl(redirectUri, state);
  if (!authUrl) return res.status(500).send('Google OAuth not configured. Set GOOGLE_CLIENT_ID env var.');

  res.redirect(authUrl);
});

// Gmail OAuth callback
app.get('/auth/gmail/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('No authorization code received.');

  let orgSlug = null, orgId = null;
  if (state) {
    const verified = verifyOAuthState(state);
    if (verified) { orgSlug = verified.slug; orgId = verified.orgId; }
  }

  try {
    const publicUrl = config.server.publicUrl || `http://localhost:${PORT}`;
    const redirectUri = `${publicUrl}/auth/gmail/callback`;
    const tokens = await exchangeGmailCode(code, redirectUri);

    if (!tokens.refresh_token) {
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

    // Fetch the connected account's email address
    let userEmail = null;
    if (tokens.access_token) {
      userEmail = await getGmailUserEmail(tokens.access_token);
    }

    if (orgId) {
      const updates = { gmail_refresh_token: prepareTokenForStorage(tokens.refresh_token, orgId), storage_type: 'gmail' };
      if (userEmail) updates.gmail_email = userEmail;
      updateOrgSettings(orgId, updates);
    }

    const backUrl = orgSlug ? `/${orgSlug}/admin` : '/';
    res.send(`
      <html><body style="font-family: Inter, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2 style="color: #2e8540;">Gmail Connected!</h2>
        <p>Your Gmail account${userEmail ? ` (${escapeHtml(userEmail)})` : ''} has been connected for sending emails.</p>
        <a href="${backUrl}" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#0071bc;color:#fff;border-radius:4px;text-decoration:none;font-weight:600;">Back to Admin Settings</a>
      </body></html>
    `);
  } catch (err) {
    const backUrl = orgSlug ? `/${escapeHtml(orgSlug)}/admin` : '/';
    res.status(500).send(`
      <html><body style="font-family: Inter, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2 style="color: #e31c3d;">Gmail Authorization Failed</h2>
        <p>${escapeHtml(err.message)}</p>
        <a href="${backUrl}">Go back</a>
      </body></html>
    `);
  }
});

// Per-org Outlook OAuth connect
app.get('/api/orgs/:slug/outlook-connect', (req, res) => {
  const org = getOrgBySlug(req.params.slug);
  if (!org) return res.status(404).send('Organization not found.');

  const publicUrl = config.server.publicUrl || `http://localhost:${PORT}`;
  const redirectUri = `${publicUrl}/auth/outlook/callback`;
  const state = createSignedOAuthState(org.slug, org.id);

  const authUrl = getOutlookMailAuthUrl(redirectUri, state);
  if (!authUrl) return res.status(500).send('Microsoft OAuth not configured. Set ONEDRIVE_CLIENT_ID env var.');

  res.redirect(authUrl);
});

// Outlook OAuth callback
app.get('/auth/outlook/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('No authorization code received.');

  let orgSlug = null, orgId = null;
  if (state) {
    const verified = verifyOAuthState(state);
    if (verified) { orgSlug = verified.slug; orgId = verified.orgId; }
  }

  try {
    const publicUrl = config.server.publicUrl || `http://localhost:${PORT}`;
    const redirectUri = `${publicUrl}/auth/outlook/callback`;
    const tokens = await exchangeOutlookMailCode(code, redirectUri);

    // Fetch the connected account's email address
    let userEmail = null;
    if (tokens.access_token) {
      userEmail = await getOutlookUserEmail(tokens.access_token);
    }

    if (orgId && tokens.refresh_token) {
      const updates = { outlook_refresh_token: prepareTokenForStorage(tokens.refresh_token, orgId), storage_type: 'outlook' };
      if (userEmail) updates.outlook_email = userEmail;
      updateOrgSettings(orgId, updates);
    }

    const backUrl = orgSlug ? `/${orgSlug}/admin` : '/';
    res.send(`
      <html><body style="font-family: Inter, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2 style="color: #2e8540;">Microsoft Email Connected!</h2>
        <p>Your Microsoft account${userEmail ? ` (${escapeHtml(userEmail)})` : ''} has been connected for sending emails.</p>
        <a href="${backUrl}" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#0071bc;color:#fff;border-radius:4px;text-decoration:none;font-weight:600;">Back to Admin Settings</a>
      </body></html>
    `);
  } catch (err) {
    const backUrl = orgSlug ? `/${escapeHtml(orgSlug)}/admin` : '/';
    res.status(500).send(`
      <html><body style="font-family: Inter, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2 style="color: #e31c3d;">Microsoft Email Authorization Failed</h2>
        <p>${escapeHtml(err.message)}</p>
        <a href="${backUrl}">Go back</a>
      </body></html>
    `);
  }
});

// ══════════════════════════════════════════════════════════════════
//  CLIENT-SIDE SHL ARCHITECTURE — CORS Proxy + Route Endpoint
//  The browser handles SHL decryption. The server only:
//    1. Proxies encrypted manifest fetches (CORS bridge)
//    2. Routes already-decrypted data to storage destinations
//  PHI never touches the server in decrypted form.
// ══════════════════════════════════════════════════════════════════

// SSRF protection: block requests to private/internal networks
function isPrivateUrl(urlString) {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();

    // Block non-HTTP protocols first
    if (!['http:', 'https:'].includes(url.protocol)) return true;

    // Block private IPs and localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    if (hostname === '0.0.0.0') return true;
    if (hostname.endsWith('.local')) return true;
    if (hostname.endsWith('.internal')) return true;

    // Block cloud metadata endpoints (AWS, GCP, Azure)
    if (hostname === '169.254.169.254') return true;
    if (hostname === 'metadata.google.internal') return true;

    // Block IPv6-mapped IPv4 addresses (e.g., ::ffff:127.0.0.1)
    const ipv6MappedMatch = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (ipv6MappedMatch) {
      // Re-check the embedded IPv4 address
      return isPrivateIpv4(ipv6MappedMatch[1]);
    }

    // Block IPv6 private ranges
    if (hostname.startsWith('fe80:')) return true;   // Link-local
    if (hostname.startsWith('fc') || hostname.startsWith('fd')) return true; // Unique local
    if (hostname === '::') return true;               // Unspecified

    // Block RFC 1918 ranges (IPv4)
    if (isPrivateIpv4(hostname)) return true;

    return false;
  } catch {
    return true; // Malformed URLs are blocked
  }
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4 || !parts.every(p => /^\d+$/.test(p))) return false;
  const [a, b] = parts.map(Number);
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16 (link-local)
  if (a === 127) return true;                          // 127.0.0.0/8 (loopback)
  return false;
}

// SHL CORS Proxy — forwards encrypted requests to SHL manifest servers
// The decryption key never leaves the browser. Server only sees encrypted JWE blobs.
app.post('/api/orgs/:slug/shl-proxy', proxyLimiter, authMiddleware('staff'), async (req, res) => {
  const { url, method = 'GET', body = null, headers = {} } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // SSRF protection
  if (isPrivateUrl(url)) {
    return res.status(403).json({ error: 'Requests to private/internal addresses are not allowed' });
  }

  try {
    const fetchOptions = {
      method: method.toUpperCase(),
      headers: {},
      redirect: 'manual',  // Don't follow redirects — prevents SSRF via redirect to private IPs
    };

    // Only allow safe headers to be forwarded
    const safeHeaders = ['content-type', 'accept'];
    for (const [key, value] of Object.entries(headers)) {
      if (safeHeaders.includes(key.toLowerCase())) {
        fetchOptions.headers[key] = value;
      }
    }

    if (body && ['POST', 'PUT'].includes(fetchOptions.method)) {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (!fetchOptions.headers['Content-Type'] && !fetchOptions.headers['content-type']) {
        fetchOptions.headers['Content-Type'] = 'application/json';
      }
    }

    let proxyResp = await fetch(url, fetchOptions);

    // Handle redirects safely — validate each redirect target against SSRF
    let redirectCount = 0;
    const MAX_REDIRECTS = 3;
    while (proxyResp.status >= 300 && proxyResp.status < 400 && redirectCount < MAX_REDIRECTS) {
      const location = proxyResp.headers.get('location');
      if (!location) break;

      const redirectUrl = new URL(location, url).toString();
      if (isPrivateUrl(redirectUrl)) {
        return res.status(403).json({ error: 'Redirect to private/internal address blocked' });
      }

      proxyResp = await fetch(redirectUrl, { ...fetchOptions, method: 'GET' });
      redirectCount++;
    }

    if (redirectCount >= MAX_REDIRECTS) {
      return res.status(502).json({ error: 'Too many redirects from SHL server' });
    }

    const responseText = await proxyResp.text();

    // Return the raw response so the browser can handle decryption
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(responseText);
    } catch {
      // Not JSON — likely a JWE string, which is expected
    }

    res.json({
      status: proxyResp.status,
      body: responseText,
      parsedBody,
    });
  } catch (err) {
    console.error(`[${req.params.slug}] SHL proxy error: ${err.message}`);
    res.status(502).json({ error: `Failed to reach SHL server: ${err.message}` });
  }
});

// Route endpoint — receives already-decrypted data from browser and routes to storage
// The browser decrypted the SHL data; this endpoint only handles delivery.
app.post('/api/orgs/:slug/route', authMiddleware('staff'), async (req, res) => {
  const { fhirBundles = [], pdfs = [], label = null } = req.body;
  const org = getOrgBySlug(req.params.slug);

  if (!org) return res.status(404).json({ error: 'Organization not found.' });

  // Re-validate FHIR on server side as a safety check
  if (fhirBundles.length > 0) {
    const validation = validateFhirBundles(fhirBundles);
    if (!validation.valid) {
      return res.status(400).json({
        status: 'validation_failed',
        error: `Invalid FHIR data: ${validation.errors.join('; ')}`,
      });
    }
  }

  // Filter results based on org's save format preference
  const saveFormat = org.save_format || 'both';
  const filteredResults = {
    fhirBundles: saveFormat === 'pdf' ? [] : fhirBundles,
    pdfs: saveFormat === 'fhir' ? [] : pdfs.map(p => ({
      filename: p.filename,
      data: p.dataBase64 ? Buffer.from(p.dataBase64, 'base64') : null,
      url: p.url || null,
    })),
    raw: [],
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
        refreshToken: getDecryptedToken(org, 'drive_refresh_token'),
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

  if (org.storage_type === 'gmail' && org.gmail_refresh_token && org.email_to) {
    try {
      await sendViaGmail(filteredResults, {
        refreshToken: getDecryptedToken(org, 'gmail_refresh_token'),
        to: org.email_to,
      }, { verbose: false });
      emailSent = true;
    } catch (err) {
      emailError = err.message;
      console.error(`[${org.slug}] Gmail send failed: ${err.message}`);
    }
  }

  if (org.storage_type === 'outlook' && org.outlook_refresh_token && org.email_to) {
    try {
      await sendViaOutlook(filteredResults, {
        refreshToken: getDecryptedToken(org, 'outlook_refresh_token'),
        to: org.email_to,
      }, { verbose: false });
      emailSent = true;
    } catch (err) {
      emailError = err.message;
      console.error(`[${org.slug}] Outlook send failed: ${err.message}`);
    }
  }

  if (org.storage_type === 'onedrive' && org.onedrive_refresh_token) {
    try {
      const odConfig = {
        refreshToken: getDecryptedToken(org, 'onedrive_refresh_token'),
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
        refreshToken: getDecryptedToken(org, 'box_refresh_token'),
        folderId: org.box_folder_id,
      };
      const boxSummary = await uploadToBox(filteredResults, boxConfig, { verbose: false });
      boxLink = boxSummary.folderLink;
      if (boxSummary.newRefreshToken) {
        updateOrgSettings(org.id, { box_refresh_token: prepareTokenForStorage(boxSummary.newRefreshToken, org.id) });
      }
    } catch (err) {
      boxError = err.message;
      console.error(`[${org.slug}] Box upload failed: ${err.message}`);
    }
  }

  // Audit log — record the scan event (metadata only, no PHI content)
  const anyError = driveError || onedriveError || boxError || emailError || apiError;
  logAuditEvent({
    orgSlug: org.slug,
    eventType: 'scan_route',
    storageType: org.storage_type,
    fhirBundleCount: filteredResults.fhirBundles.length,
    pdfCount: filteredResults.pdfs.length,
    success: !anyError,
    errorMessage: anyError || null,
    ipAddress: req.ip,
    userAgent: req.get('user-agent')?.slice(0, 200) || null,
  });

  res.json({
    status: 'success',
    label,
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
      rawEntries: 0,
    },
    fhirBundles: filteredResults.fhirBundles,
    pdfs: pdfs.map(p => ({
      filename: p.filename,
      hasData: !!p.dataBase64,
      dataBase64: p.dataBase64 || null,
      url: p.url || null,
    })),
  });
});

// Per-org scan — LEGACY server-side processing (kept for CLI and backward compatibility)
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
          refreshToken: getDecryptedToken(org, 'drive_refresh_token'),
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

    if (org.storage_type === 'gmail' && org.gmail_refresh_token && org.email_to) {
      try {
        await sendViaGmail(filteredResults, {
          refreshToken: getDecryptedToken(org, 'gmail_refresh_token'),
          to: org.email_to,
        }, { verbose: false });
        emailSent = true;
      } catch (err) {
        emailError = err.message;
        console.error(`[${org.slug}] Gmail send failed: ${err.message}`);
      }
    }

    if (org.storage_type === 'outlook' && org.outlook_refresh_token && org.email_to) {
      try {
        await sendViaOutlook(filteredResults, {
          refreshToken: getDecryptedToken(org, 'outlook_refresh_token'),
          to: org.email_to,
        }, { verbose: false });
        emailSent = true;
      } catch (err) {
        emailError = err.message;
        console.error(`[${org.slug}] Outlook send failed: ${err.message}`);
      }
    }

    if (org.storage_type === 'onedrive' && org.onedrive_refresh_token) {
      try {
        const odConfig = {
          refreshToken: getDecryptedToken(org, 'onedrive_refresh_token'),
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
          refreshToken: getDecryptedToken(org, 'box_refresh_token'),
          folderId: org.box_folder_id,
        };
        const boxSummary = await uploadToBox(filteredResults, boxConfig, { verbose: false });
        boxLink = boxSummary.folderLink;
        // Box rotates refresh tokens — save the new one (encrypted)
        if (boxSummary.newRefreshToken) {
          updateOrgSettings(org.id, { box_refresh_token: prepareTokenForStorage(boxSummary.newRefreshToken, org.id) });
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
//  APPROVAL REQUESTS (Gmail/Outlook pending verification)
// ══════════════════════════════════════════════════════════════════

const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'smokeyclawd@gmail.com';

// Send admin notification about new approval request (best-effort, fire-and-forget)
async function notifyAdminNewRequest({ orgName, orgSlug, email, service }) {
  try {
    const nodemailer = await import('nodemailer');
    const smtpHost = process.env.SMTP_HOST;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpFrom = process.env.SMTP_FROM;

    if (!smtpHost || !smtpUser || !smtpPass) {
      console.log(`[Approval] New request from ${orgName} (${email}) for ${service} — no SMTP configured, skipping email notification.`);
      console.log(`[Approval] To enable notifications, set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM env vars.`);
      return;
    }

    const transporter = nodemailer.default.createTransport({
      host: smtpHost,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: smtpUser, pass: smtpPass },
    });

    await transporter.sendMail({
      from: smtpFrom || smtpUser,
      to: ADMIN_NOTIFY_EMAIL,
      subject: `[Kill the Clipboard] New ${service} approval request from ${orgName}`,
      text: [
        `New approval request:`,
        ``,
        `Organization: ${orgName} (/${orgSlug})`,
        `Email: ${email}`,
        `Service: ${service === 'gmail' ? 'Gmail' : 'Microsoft Outlook'}`,
        ``,
        `Action needed:`,
        `1. Add ${email} as a test user in ${service === 'gmail' ? 'Google Cloud Console' : 'Azure Portal'}`,
        `2. Mark the request as approved via the admin API`,
        ``,
        `— Kill the Clipboard`,
      ].join('\n'),
    });
    console.log(`[Approval] Notification email sent to ${ADMIN_NOTIFY_EMAIL}`);
  } catch (err) {
    console.error(`[Approval] Failed to send notification email:`, err.message);
  }
}

// Org admin submits a request to be approved for Gmail/Outlook access
app.post('/api/orgs/:slug/request-approval', authMiddleware('admin'), (req, res) => {
  const org = getOrgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: 'Org not found' });

  const { email, service } = req.body;
  if (!email || !service) {
    return res.status(400).json({ error: 'Email and service are required' });
  }
  if (!['gmail', 'outlook'].includes(service)) {
    return res.status(400).json({ error: 'Service must be gmail or outlook' });
  }

  const result = createApprovalRequest({
    orgSlug: org.slug,
    orgName: org.name,
    email,
    service,
  });

  if (result.alreadyExists) {
    return res.json({ success: true, message: 'Your request has already been submitted and is awaiting approval.' });
  }

  // Fire-and-forget: send admin notification email
  notifyAdminNewRequest({ orgName: org.name, orgSlug: org.slug, email, service });

  res.json({ success: true, message: 'Your request has been submitted. You will be notified when your account is approved.' });
});

// Check approval status for a given email + service
app.get('/api/orgs/:slug/approval-status', authMiddleware('admin'), (req, res) => {
  const org = getOrgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: 'Org not found' });

  const { email, service } = req.query;
  if (!email || !service) return res.json({ status: 'none' });

  const row = getDb().prepare(
    'SELECT status FROM approval_requests WHERE org_slug = ? AND email = ? AND service = ? ORDER BY created_at DESC LIMIT 1'
  ).get(org.slug, email, service);

  res.json({ status: row ? row.status : 'none' });
});

// Audit log: list recent scan events for an organization (admin only, no PHI)
app.get('/api/orgs/:slug/audit-log', authMiddleware('admin'), (req, res) => {
  const org = getOrgBySlug(req.params.slug);
  if (!org) return res.status(404).json({ error: 'Org not found' });
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const entries = listAuditLog(org.slug, limit);
  res.json(entries);
});

// ── Super-admin middleware ──
function superAdminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  const expected = process.env.ADMIN_KEY || 'ktc-admin-2026';
  if (!key || typeof key !== 'string') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  // Timing-safe comparison to prevent timing side-channel attacks
  const keyBuf = Buffer.from(key);
  const expectedBuf = Buffer.from(expected);
  if (keyBuf.length !== expectedBuf.length || !timingSafeEqual(keyBuf, expectedBuf)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// Super-admin: list all pending approval requests
app.get('/api/admin/approval-requests', authLimiter, superAdminAuth, (req, res) => {
  const requests = listApprovalRequests(req.query.status || null);
  res.json(requests);
});

// Super-admin: approve or reject a request
app.post('/api/admin/approval-requests/:id', superAdminAuth, (req, res) => {
  const { status } = req.body;
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status must be approved or rejected' });
  }
  updateApprovalRequest(req.params.id, status);
  res.json({ success: true });
});

// Super-admin: list all organizations
app.get('/api/admin/orgs', superAdminAuth, (req, res) => {
  const orgs = listAllOrgs();
  const total = countOrgs();
  res.json({ orgs, total });
});

// Super-admin: view audit log across all organizations
app.get('/api/admin/audit-log', superAdminAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
  const entries = listAllAuditLog(limit);
  res.json(entries);
});

// Super-admin: delete an organization
app.delete('/api/admin/orgs/:id', superAdminAuth, (req, res) => {
  const org = getOrgById(req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  deleteOrgById(req.params.id);
  res.json({ success: true, message: `Deleted organization "${org.name}" (/${org.slug})` });
});

// Super-admin: reset passwords for an organization
app.post('/api/admin/orgs/:id/reset-password', superAdminAuth, async (req, res) => {
  const org = getOrgById(req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const { adminPassword, staffPassword } = req.body;
  const updates = {};

  if (adminPassword) {
    if (adminPassword.length < 8) return res.status(400).json({ error: 'Admin password must be at least 8 characters' });
    updates.admin_password_hash = await hashPassword(adminPassword);
  }
  if (staffPassword) {
    if (staffPassword.length < 4) return res.status(400).json({ error: 'Staff password must be at least 4 characters' });
    updates.staff_password_hash = await hashPassword(staffPassword);
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Provide adminPassword and/or staffPassword' });
  }

  updateOrgSettings(org.id, updates);
  res.json({ success: true, message: `Passwords updated for "${org.name}"` });
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
