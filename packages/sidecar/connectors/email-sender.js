import nodemailer from 'nodemailer';

/**
 * Send scan results via email.
 *
 * @param {object} results - { fhirBundles, pdfs, raw } from extractHealthData
 * @param {object} emailConfig - { to, smtp: { host, port, user, pass, from } }
 * @param {object} options - { verbose }
 * @returns {{ sent: boolean, messageId: string }}
 */
export async function sendEmail(results, emailConfig, options = {}) {
  const { verbose = false } = options;
  const { to, smtp } = emailConfig;

  if (!to) throw new Error('Email recipient not configured.');
  if (!smtp || !smtp.host || !smtp.user || !smtp.pass) {
    throw new Error('SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS env vars.');
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: parseInt(smtp.port, 10) || 587,
    secure: parseInt(smtp.port, 10) === 465,
    auth: {
      user: smtp.user,
      pass: smtp.pass,
    },
  });

  // Build summary text
  const bundleCount = results.fhirBundles.length;
  const pdfCount = results.pdfs.length;
  const rawCount = results.raw.length;
  const timestamp = new Date().toISOString();

  let text = `Kill the Clipboard — Scan Results\n`;
  text += `${'─'.repeat(40)}\n\n`;
  text += `Timestamp: ${timestamp}\n`;
  text += `FHIR Bundles: ${bundleCount}\n`;
  text += `PDFs: ${pdfCount}\n`;
  text += `Other entries: ${rawCount}\n\n`;

  // Extract patient info from bundles
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

  // Build attachments
  const attachments = [];

  // Attach FHIR bundles as JSON files
  for (let i = 0; i < results.fhirBundles.length; i++) {
    attachments.push({
      filename: `bundle-${i}.json`,
      content: JSON.stringify(results.fhirBundles[i], null, 2),
      contentType: 'application/json',
    });
  }

  // Attach PDFs
  for (const pdf of results.pdfs) {
    if (pdf.data) {
      attachments.push({
        filename: pdf.filename,
        content: pdf.data,
        contentType: 'application/pdf',
      });
    }
  }

  const from = smtp.from || 'Kill the Clipboard <noreply@killtheclipboard.fly.dev>';

  const info = await transporter.sendMail({
    from,
    to,
    subject: `[Kill the Clipboard] New scan — ${timestamp}`,
    text,
    attachments,
  });

  if (verbose) console.log(`Email sent: ${info.messageId}`);

  return { sent: true, messageId: info.messageId };
}
