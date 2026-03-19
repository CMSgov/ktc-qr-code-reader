/**
 * Sidecar: receives already-decrypted data from the scanner and routes to storage.
 * Only endpoint: POST /api/orgs/:slug/route (Bearer token required).
 * Org settings and OAuth tokens are stored in SQLite; config from config.json / env.
 */
import express from 'express';
import { loadConfig } from './config.js';
import {
  initDb,
  getOrgBySlug,
  getDecryptedToken,
  prepareTokenForStorage,
  updateOrgSettings,
  logAuditEvent,
} from './db.js';
import { authMiddleware } from './auth.js';
import { validateFhirBundles } from './lib/fhir-validator.js';
import { uploadToDrive } from './connectors/google-drive.js';
import { uploadToOnedrive } from './connectors/onedrive.js';
import { uploadToBox } from './connectors/box.js';
import { sendEmail } from './connectors/email-sender.js';
import { sendViaGmail } from './connectors/gmail.js';
import { sendViaOutlook } from './connectors/outlook.js';
import { postToApi } from './connectors/api-poster.js';

initDb();
const config = loadConfig();

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = Number(process.env.PORT) || config.server?.port || 3090;

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/orgs/:slug/route', authMiddleware('staff'), async (req, res) => {
  const { fhirBundles = [], pdfs = [], label = null } = req.body;
  const org = getOrgBySlug(req.params.slug);

  if (!org) return res.status(404).json({ error: 'Organization not found.' });

  if (fhirBundles.length > 0) {
    const validation = validateFhirBundles(fhirBundles);
    if (!validation.valid) {
      return res.status(400).json({
        status: 'validation_failed',
        error: `Invalid FHIR data: ${validation.errors.join('; ')}`,
      });
    }
  }

  const saveFormat = org.save_format || 'both';
  const filteredResults = {
    fhirBundles: saveFormat === 'pdf' ? [] : fhirBundles,
    pdfs:
      saveFormat === 'fhir'
        ? []
        : pdfs.map((p) => ({
            filename: p.filename,
            data: p.dataBase64 ? Buffer.from(p.dataBase64, 'base64') : null,
            url: p.url || null,
          })),
    raw: [],
  };

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
      await sendViaGmail(
        filteredResults,
        {
          refreshToken: getDecryptedToken(org, 'gmail_refresh_token'),
          to: org.email_to,
        },
        { verbose: false },
      );
      emailSent = true;
    } catch (err) {
      emailError = err.message;
      console.error(`[${org.slug}] Gmail send failed: ${err.message}`);
    }
  }

  if (org.storage_type === 'outlook' && org.outlook_refresh_token && org.email_to) {
    try {
      await sendViaOutlook(
        filteredResults,
        {
          refreshToken: getDecryptedToken(org, 'outlook_refresh_token'),
          to: org.email_to,
        },
        { verbose: false },
      );
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
        updateOrgSettings(org.id, {
          box_refresh_token: prepareTokenForStorage(boxSummary.newRefreshToken, org.id),
        });
      }
    } catch (err) {
      boxError = err.message;
      console.error(`[${org.slug}] Box upload failed: ${err.message}`);
    }
  }

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
    pdfs: pdfs.map((p) => ({
      filename: p.filename,
      hasData: !!p.dataBase64,
      url: p.url || null,
    })),
  });
});

app.listen(PORT, () => {
  console.log(`Sidecar listening on port ${PORT}`);
});
