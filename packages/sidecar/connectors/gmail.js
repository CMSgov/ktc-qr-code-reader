import MailComposer from 'nodemailer/lib/mail-composer/index.js';

/**
 * Gmail API email sender using OAuth2.
 *
 * Reuses the same GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET as Drive,
 * but with the gmail.send scope for a separate per-org refresh token.
 */

// ── Token helpers ───────────────────────────────────────────────

async function getAccessToken(refreshToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
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
    throw new Error(`Gmail token refresh failed: ${err.error_description || resp.statusText}`);
  }

  const data = await resp.json();
  return data.access_token;
}

// ── OAuth flow helpers ──────────────────────────────────────────

/**
 * Build the Google OAuth2 authorization URL for Gmail send access.
 */
export function getGmailAuthUrl(redirectUri, state) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return null;

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope:
      'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeGmailCode(code, redirectUri) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error_description || 'Gmail token exchange failed');
  }

  return resp.json();
}

/**
 * Fetch the authenticated user's email address.
 */
export async function getGmailUserEmail(accessToken) {
  const resp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.email;
}

// ── MIME builder ────────────────────────────────────────────────

async function buildRawMessage(from, to, subject, text, attachments) {
  const mail = new MailComposer({ from, to, subject, text, attachments });
  const message = await mail.compile().build();

  // Gmail requires base64url encoding (not standard base64)
  return message.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Main send function ──────────────────────────────────────────

/**
 * Send scan results via the Gmail API.
 *
 * @param {object} results  - { fhirBundles, pdfs, raw }
 * @param {object} config   - { refreshToken, to }
 * @param {object} options  - { verbose }
 */
export async function sendViaGmail(results, gmailConfig, options = {}) {
  const { refreshToken, to } = gmailConfig;
  if (!to) throw new Error('Email recipient not configured.');
  if (!refreshToken) throw new Error('Gmail not connected.');

  const accessToken = await getAccessToken(refreshToken);

  // ── Build summary text (same format as email-sender.js) ──
  const timestamp = new Date().toISOString();
  let text = `Kill the Clipboard \u2014 Scan Results\n`;
  text += `${'─'.repeat(40)}\n\n`;
  text += `Timestamp: ${timestamp}\n`;
  text += `FHIR Bundles: ${results.fhirBundles.length}\n`;
  text += `PDFs: ${results.pdfs.length}\n`;
  text += `Other entries: ${results.raw.length}\n\n`;

  for (const bundle of results.fhirBundles) {
    if (bundle.entry) {
      for (const entry of bundle.entry) {
        const r = entry.resource;
        if (r?.resourceType === 'Patient') {
          const name = r.name?.[0];
          const nameStr = name
            ? [name.given?.join(' '), name.family].filter(Boolean).join(' ')
            : 'Unknown';
          text += `Patient: ${nameStr}\n`;
          if (r.birthDate) text += `DOB: ${r.birthDate}\n`;
          text += '\n';
        }
      }
    }
  }

  // ── Build attachments ──
  const attachments = [];

  for (let i = 0; i < results.fhirBundles.length; i++) {
    attachments.push({
      filename: `bundle-${i}.json`,
      content: JSON.stringify(results.fhirBundles[i], null, 2),
      contentType: 'application/json',
    });
  }

  for (const pdf of results.pdfs) {
    if (pdf.data) {
      attachments.push({
        filename: pdf.filename,
        content: pdf.data,
        contentType: 'application/pdf',
      });
    }
  }

  // ── Send via Gmail API ──
  const raw = await buildRawMessage(
    'me',
    to,
    `[Kill the Clipboard] New scan \u2014 ${timestamp}`,
    text,
    attachments,
  );

  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Gmail send failed: ${err.error?.message || resp.statusText}`);
  }

  const data = await resp.json();
  if (options.verbose) console.log(`Gmail sent: ${data.id}`);

  return { sent: true, messageId: data.id };
}
