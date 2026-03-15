/**
 * Microsoft Graph sendMail — send scan results via Outlook / Microsoft 365.
 *
 * Reuses the same ONEDRIVE_CLIENT_ID / ONEDRIVE_CLIENT_SECRET as OneDrive,
 * but with the Mail.Send scope for a separate per-org refresh token.
 */

// ── Token helpers ───────────────────────────────────────────────

async function getAccessToken(refreshToken) {
  const clientId = process.env.ONEDRIVE_CLIENT_ID;
  const clientSecret = process.env.ONEDRIVE_CLIENT_SECRET;

  const resp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: 'Mail.Send User.Read offline_access',
    }).toString(),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Outlook token refresh failed: ${err.error_description || resp.statusText}`);
  }

  const data = await resp.json();
  return data.access_token;
}

// ── OAuth flow helpers ──────────────────────────────────────────

/**
 * Build the Microsoft OAuth2 authorization URL for Mail.Send access.
 */
export function getOutlookMailAuthUrl(redirectUri, state) {
  const clientId = process.env.ONEDRIVE_CLIENT_ID;
  if (!clientId) return null;

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'Mail.Send User.Read offline_access',
    state,
    prompt: 'consent',
  });

  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeOutlookMailCode(code, redirectUri) {
  const clientId = process.env.ONEDRIVE_CLIENT_ID;
  const clientSecret = process.env.ONEDRIVE_CLIENT_SECRET;

  const resp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      scope: 'Mail.Send User.Read offline_access',
    }).toString(),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error_description || 'Outlook token exchange failed');
  }

  return resp.json();
}

/**
 * Fetch the authenticated user's email address.
 */
export async function getOutlookUserEmail(accessToken) {
  const resp = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.mail || data.userPrincipalName;
}

// ── Main send function ──────────────────────────────────────────

/**
 * Send scan results via Microsoft Graph sendMail.
 *
 * @param {object} results       - { fhirBundles, pdfs, raw }
 * @param {object} outlookConfig - { refreshToken, to }
 * @param {object} options       - { verbose }
 */
export async function sendViaOutlook(results, outlookConfig, options = {}) {
  const { refreshToken, to } = outlookConfig;
  if (!to) throw new Error('Email recipient not configured.');
  if (!refreshToken) throw new Error('Outlook not connected.');

  const accessToken = await getAccessToken(refreshToken);

  // ── Build body text (same format as email-sender.js) ──
  const timestamp = new Date().toISOString();
  let bodyContent = `Kill the Clipboard \u2014 Scan Results\n`;
  bodyContent += `${'─'.repeat(40)}\n\n`;
  bodyContent += `Timestamp: ${timestamp}\n`;
  bodyContent += `FHIR Bundles: ${results.fhirBundles.length}\n`;
  bodyContent += `PDFs: ${results.pdfs.length}\n`;
  bodyContent += `Other entries: ${results.raw.length}\n\n`;

  for (const bundle of results.fhirBundles) {
    if (bundle.entry) {
      for (const entry of bundle.entry) {
        const r = entry.resource;
        if (r?.resourceType === 'Patient') {
          const name = r.name?.[0];
          const nameStr = name
            ? [name.given?.join(' '), name.family].filter(Boolean).join(' ')
            : 'Unknown';
          bodyContent += `Patient: ${nameStr}\n`;
          if (r.birthDate) bodyContent += `DOB: ${r.birthDate}\n`;
          bodyContent += '\n';
        }
      }
    }
  }

  // ── Build Graph API attachments ──
  const attachments = [];

  for (let i = 0; i < results.fhirBundles.length; i++) {
    const content = JSON.stringify(results.fhirBundles[i], null, 2);
    attachments.push({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: `bundle-${i}.json`,
      contentType: 'application/json',
      contentBytes: Buffer.from(content).toString('base64'),
    });
  }

  for (const pdf of results.pdfs) {
    if (pdf.data) {
      const b64 = Buffer.isBuffer(pdf.data)
        ? pdf.data.toString('base64')
        : Buffer.from(pdf.data).toString('base64');
      attachments.push({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: pdf.filename,
        contentType: 'application/pdf',
        contentBytes: b64,
      });
    }
  }

  // ── Build and send the mail payload ──
  const mailPayload = {
    message: {
      subject: `[Kill the Clipboard] New scan \u2014 ${timestamp}`,
      body: {
        contentType: 'Text',
        content: bodyContent,
      },
      toRecipients: to.split(',').map((addr) => ({
        emailAddress: { address: addr.trim() },
      })),
      attachments,
    },
    saveToSentItems: false,
  };

  const resp = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(mailPayload),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Outlook send failed: ${err.error?.message || resp.statusText}`);
  }

  // sendMail returns 202 Accepted with no body on success
  if (options.verbose) console.log('Outlook email sent successfully.');

  return { sent: true };
}
