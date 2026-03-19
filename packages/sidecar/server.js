/**
 * Sidecar: receives already-decrypted data from the scanner and routes to storage.
 * Only endpoint: POST /api/orgs/:slug/route (Bearer token required).
 * Org settings and OAuth tokens are stored in SQLite; config from config.json / env.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import pinoHttp from 'pino-http';
import { logger } from './lib/logger.js';
import { loadConfig } from './config.js';
import {
  initDb,
  getDb,
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

// --- Crash handlers (set up early to catch startup errors) ---
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ error: String(reason) }, 'unhandled rejection');
  process.exit(1);
});

// --- Startup validation ---
if (!process.env.SESSION_SECRET) {
  logger.fatal(
    'SESSION_SECRET environment variable is required — set it to a random string of at least 32 characters',
  );
  process.exit(1);
}
if (process.env.SESSION_SECRET.length < 32) {
  logger.fatal('SESSION_SECRET must be at least 32 characters long');
  process.exit(1);
}

initDb();
const config = loadConfig();

const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
app.use(express.json({ limit: '10mb' }));

const PORT = Number(process.env.PORT) || config.server?.port || 3090;

// --- Security headers ---
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// --- Middleware ---
app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const id = req.headers['x-request-id'] || randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  }),
);

// --- Health checks ---

app.get('/livez', (_req, res) => res.json({ status: 'ok' }));

app.get('/readyz', (_req, res) => {
  try {
    getDb().prepare('SELECT 1').get();
    res.json({ status: 'ok', checks: { database: 'ok' } });
  } catch (err) {
    logger.error({ err }, 'readiness check failed');
    res.status(503).json({ status: 'not_ready', checks: { database: err.message } });
  }
});

app.get('/healthz', (_req, res) => {
  try {
    getDb().prepare('SELECT 1').get();
    res.json({ status: 'ok', checks: { database: 'ok' } });
  } catch (err) {
    logger.error({ err }, 'health check failed');
    res.status(503).json({ status: 'degraded', checks: { database: err.message } });
  }
});

// --- Input validation ---

function validateRouteBody(body) {
  const errors = [];
  if (body == null || typeof body !== 'object') {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }
  const { fhirBundles, pdfs, label } = body;
  if (fhirBundles !== undefined && !Array.isArray(fhirBundles)) {
    errors.push('fhirBundles must be an array');
  }
  if (pdfs !== undefined) {
    if (!Array.isArray(pdfs)) {
      errors.push('pdfs must be an array');
    } else {
      for (let i = 0; i < pdfs.length; i++) {
        const pdf = pdfs[i];
        if (!pdf || typeof pdf !== 'object') {
          errors.push(`pdfs[${i}]: must be an object`);
        } else if (typeof pdf.filename !== 'string' || pdf.filename.length === 0) {
          errors.push(`pdfs[${i}]: filename is required and must be a non-empty string`);
        }
      }
    }
  }
  if (label !== undefined && label !== null && typeof label !== 'string') {
    errors.push('label must be a string or null');
  }
  return { valid: errors.length === 0, errors };
}

// --- Routes ---

app.post('/api/orgs/:slug/route', authMiddleware('staff'), async (req, res) => {
  const bodyValidation = validateRouteBody(req.body);
  if (!bodyValidation.valid) {
    return res.status(400).json({
      status: 'validation_failed',
      error: bodyValidation.errors.join('; '),
    });
  }

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
      req.log.error({ org: org.slug, err }, 'Drive upload failed');
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
      req.log.error({ org: org.slug, err }, 'API post failed');
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
      req.log.error({ org: org.slug, err }, 'Email send failed');
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
      req.log.error({ org: org.slug, err }, 'Gmail send failed');
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
      req.log.error({ org: org.slug, err }, 'Outlook send failed');
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
      req.log.error({ org: org.slug, err }, 'OneDrive upload failed');
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
      req.log.error({ org: org.slug, err }, 'Box upload failed');
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

// --- Global error handler ---
app.use((err, req, res, _next) => {
  req.log?.error({ err }, 'unhandled error');
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error', requestId: req.id });
  }
});

// --- Start server ---
const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'sidecar started');
});

// --- Graceful shutdown ---
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown signal received');
  server.close(() => {
    try {
      getDb().close();
      logger.info('database connection closed');
    } catch {
      /* already closed */
    }
    logger.info('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    logger.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
