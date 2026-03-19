import { program } from 'commander';
import { extname } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { readQrFromImage } from './input/image-reader.js';
import { readQrFromPdf } from './input/pdf-reader.js';
import { parseShlUri } from './shl/uri-parser.js';
import { fetchManifest } from './shl/manifest.js';
import { extractHealthData } from './shl/fhir-extractor.js';
import { writeToFiles } from './output/file-writer.js';
import { postToApi } from './output/api-poster.js';
import { uploadToDrive } from './output/drive-uploader.js';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tiff', '.tif']);
const PDF_EXTS = new Set(['.pdf']);

export async function run(argv) {
  program
    .name('shl-scan')
    .description('Scan a QR code containing a SMART Health Link and extract health data')
    .argument('<input>', 'Path to image file (PNG, JPG) or PDF containing a QR code')
    .option('-o, --output <dir>', 'Output directory (overrides config)')
    .option('-p, --passcode <code>', 'Passcode for P-flagged links')
    .option('-r, --recipient <name>', 'Recipient identifier')
    .option('--api <url>', 'POST results to this API endpoint')
    .option('--fhir-server <url>', 'POST FHIR bundles to this FHIR server')
    .option('--drive-folder <url>', 'Upload results to this Google Drive folder (URL or ID)')
    .option('--config <path>', 'Path to config file')
    .option('-v, --verbose', 'Enable verbose output')
    .option('-q, --quiet', 'Suppress all non-error output')
    .parse(argv);

  const opts = program.opts();
  const inputPath = program.args[0];

  // Load config with CLI overrides
  const config = loadConfig({
    output: opts.output,
    api: opts.api,
    fhirServer: opts.fhirServer,
    driveFolder: opts.driveFolder,
    recipient: opts.recipient,
    passcode: opts.passcode,
    verbose: opts.verbose,
    configPath: opts.config,
  });

  const verbose = config.verbose && !opts.quiet;
  const log = verbose ? (...args) => console.error(...args) : () => {};

  // Validate input file
  if (!existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(2);
  }

  const ext = extname(inputPath).toLowerCase();

  if (!IMAGE_EXTS.has(ext) && !PDF_EXTS.has(ext)) {
    console.error(`Unsupported file format: ${ext}`);
    console.error(`Supported: ${[...IMAGE_EXTS, ...PDF_EXTS].join(', ')}`);
    process.exit(2);
  }

  // Step 1: Read QR code from input
  log(`Scanning ${inputPath} for QR code...`);

  let qrText;
  if (PDF_EXTS.has(ext)) {
    qrText = await readQrFromPdf(inputPath, config.processing);
  } else {
    qrText = await readQrFromImage(inputPath);
  }

  if (!qrText) {
    log('No QR code found in file.');
    process.exit(0); // Silent exit per spec
  }

  log(`QR decoded: ${qrText.slice(0, 80)}${qrText.length > 80 ? '...' : ''}`);

  // Step 2: Parse SHL URI — exit silently if not a valid shlink
  let shlPayload;
  try {
    shlPayload = parseShlUri(qrText);
  } catch (err) {
    // Expired link or other parse error
    console.error(err.message);
    process.exit(1);
  }

  if (!shlPayload) {
    log('QR code does not contain a SMART Health Link. Exiting.');
    process.exit(0); // Not an SHL — do nothing
  }

  log(`SHL found: ${shlPayload.label || '(no label)'}`);
  if (shlPayload.flag) log(`Flags: ${shlPayload.flag}`);

  // Step 3: Fetch manifest
  log('Fetching SHL manifest...');
  const manifest = await fetchManifest(shlPayload, {
    recipient: config.recipient,
    passcode: config.passcode,
  });

  log(`Manifest contains ${manifest.files?.length || 0} file(s)`);

  // Step 4: Decrypt and extract health data
  log('Decrypting and extracting health data...');
  const results = await extractHealthData(manifest, shlPayload.key, {
    maxDecompressedSize: config.processing?.maxDecompressedSize,
    verbose,
  });

  log(`Extracted: ${results.fhirBundles.length} FHIR bundle(s), ${results.pdfs.length} PDF(s)`);

  if (results.fhirBundles.length === 0 && results.pdfs.length === 0 && results.raw.length === 0) {
    log('No health data found in SHL.');
    process.exit(0);
  }

  // Step 5: Deliver output
  const mode = config.output.mode;

  if (['file', 'both', 'all'].includes(mode)) {
    log(`Writing to ${config.output.directory}...`);
    const summary = await writeToFiles(results, config.output.directory, { verbose });
    if (!opts.quiet) {
      console.log(
        `Saved ${summary.fhirBundles} FHIR bundle(s) and ${summary.pdfs} PDF(s) to ${config.output.directory}`,
      );
    }
  }

  if (['api', 'both', 'all'].includes(mode)) {
    if (config.output.api.url || config.output.api.fhirServerBase) {
      log('Posting to API...');
      const posted = await postToApi(results, config.output.api, { verbose });
      if (!opts.quiet) {
        console.log(`Posted ${posted.fhir} FHIR bundle(s) to API`);
      }
    } else if (mode === 'api') {
      console.error(
        'API mode configured but no API URL set. Use --api <url> or set output.api.url in config.',
      );
      process.exit(3);
    }
  }

  if (['drive', 'all'].includes(mode)) {
    if (config.output.drive.folderId) {
      log('Uploading to Google Drive...');
      const driveSummary = await uploadToDrive(results, config.output.drive, { verbose });
      if (!opts.quiet) {
        console.log(
          `Uploaded ${driveSummary.fhirBundles} FHIR bundle(s) and ${driveSummary.pdfs} PDF(s) to Google Drive`,
        );
        if (driveSummary.driveFolder) console.log(`  ${driveSummary.driveFolder}`);
      }
    } else {
      console.error(
        'Drive mode configured but no folder set. Use --drive-folder <url> or set GOOGLE_DRIVE_FOLDER.',
      );
      process.exit(3);
    }
  }
}
