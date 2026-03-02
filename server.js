import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { loadConfig } from './src/config.js';
import { parseShlUri } from './src/shl/uri-parser.js';
import { fetchManifest } from './src/shl/manifest.js';
import { extractHealthData } from './src/shl/fhir-extractor.js';
import { writeToFiles } from './src/output/file-writer.js';
import { postToApi } from './src/output/api-poster.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const config = loadConfig();

const PORT = process.env.PORT || config.server?.port || 3000;
const HOST = process.env.HOST || config.server?.host || '0.0.0.0';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(__dirname, 'public')));

// API: process a scanned QR code string
app.post('/api/scan', async (req, res) => {
  const { qrText, passcode } = req.body;

  if (!qrText) {
    return res.status(400).json({ error: 'No QR text provided' });
  }

  // Parse SHL URI
  let shlPayload;
  try {
    shlPayload = parseShlUri(qrText);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!shlPayload) {
    return res.json({ status: 'not_shl', message: 'QR code does not contain a SMART Health Link.' });
  }

  // Check if passcode is needed
  if (shlPayload.flag.includes('P') && !passcode && !config.passcode) {
    return res.json({
      status: 'need_passcode',
      label: shlPayload.label,
      message: 'This link requires a passcode.',
    });
  }

  try {
    // Fetch manifest
    const manifest = await fetchManifest(shlPayload, {
      recipient: config.recipient,
      passcode: passcode || config.passcode,
    });

    // Decrypt and extract
    const results = await extractHealthData(manifest, shlPayload.key, {
      maxDecompressedSize: config.processing?.maxDecompressedSize,
      verbose: false,
    });

    // Save to files if configured
    let savedTo = null;
    if (config.output.mode === 'file' || config.output.mode === 'both') {
      await writeToFiles(results, config.output.directory, { verbose: false });
      savedTo = config.output.directory;
    }

    // Post to API if configured
    if (config.output.mode === 'api' || config.output.mode === 'both') {
      if (config.output.api.url || config.output.api.fhirServerBase) {
        await postToApi(results, config.output.api, { verbose: false });
      }
    }

    // Build response for the frontend
    const response = {
      status: 'success',
      label: shlPayload.label,
      savedTo,
      summary: {
        fhirBundles: results.fhirBundles.length,
        pdfs: results.pdfs.length,
        rawEntries: results.raw.length,
      },
      fhirBundles: results.fhirBundles,
      pdfs: results.pdfs.map((p) => ({
        filename: p.filename,
        hasData: !!p.data,
        url: p.url || null,
      })),
    };

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: get current config (non-sensitive fields)
app.get('/api/config', (req, res) => {
  res.json({
    outputMode: config.output.mode,
    outputDirectory: config.output.directory,
    hasApiUrl: !!config.output.api.url,
    hasFhirServer: !!config.output.api.fhirServerBase,
    recipient: config.recipient,
    orgName: config.organization?.name || null,
    orgId: config.organization?.id || null,
  });
});

// Get the local network IP for phone access
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
  console.log('');
});
