import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Write extracted health data to the local filesystem.
 *
 * Output structure:
 *   <dir>/fhir/bundle-0.json
 *   <dir>/fhir/bundle-1.json
 *   <dir>/pdfs/<filename>.pdf
 *   <dir>/summary.json
 */
export async function writeToFiles(results, outputDir, options = {}) {
  const { verbose = false } = options;

  const fhirDir = join(outputDir, 'fhir');
  const pdfDir = join(outputDir, 'pdfs');

  mkdirSync(fhirDir, { recursive: true });
  mkdirSync(pdfDir, { recursive: true });

  const written = { fhir: [], pdfs: [] };

  // Write FHIR bundles
  for (let i = 0; i < results.fhirBundles.length; i++) {
    const filename = `bundle-${i}.json`;
    const path = join(fhirDir, filename);
    writeFileSync(path, JSON.stringify(results.fhirBundles[i], null, 2));
    written.fhir.push(path);
    if (verbose) console.error(`Wrote ${path}`);
  }

  // Write PDFs
  for (const pdf of results.pdfs) {
    if (pdf.data) {
      const path = join(pdfDir, pdf.filename);
      writeFileSync(path, pdf.data);
      written.pdfs.push(path);
      if (verbose) console.error(`Wrote ${path}`);
    } else if (pdf.url) {
      // Fetch PDF from URL
      try {
        const resp = await fetch(pdf.url);
        if (resp.ok) {
          const buffer = Buffer.from(await resp.arrayBuffer());
          const path = join(pdfDir, pdf.filename);
          writeFileSync(path, buffer);
          written.pdfs.push(path);
          if (verbose) console.error(`Fetched and wrote ${path}`);
        }
      } catch (err) {
        if (verbose) console.error(`Failed to fetch PDF from ${pdf.url}: ${err.message}`);
      }
    }
  }

  // Write raw entries
  for (let i = 0; i < results.raw.length; i++) {
    const entry = results.raw[i];
    const filename = `raw-${entry.type.replace(/[^a-zA-Z0-9]/g, '_')}-${i}.json`;
    const path = join(outputDir, filename);
    writeFileSync(path, JSON.stringify(entry.data, null, 2));
    if (verbose) console.error(`Wrote ${path}`);
  }

  // Write summary
  const summary = {
    timestamp: new Date().toISOString(),
    fhirBundles: written.fhir.length,
    pdfs: written.pdfs.length,
    rawEntries: results.raw.length,
    files: {
      fhir: written.fhir,
      pdfs: written.pdfs,
    },
  };
  writeFileSync(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));

  return summary;
}
