import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readQrFromImage } from './image-reader.js';

/**
 * Read a QR code from a PDF file by rendering pages to images via macOS qlmanage,
 * then scanning each page image with jsqr.
 * Returns the decoded QR string or null if no QR found.
 */
export async function readQrFromPdf(filePath, options = {}) {
  const { pdfMaxPages = 10, pdfScanScale = 2.0 } = options;
  const tmpDir = mkdtempSync(join(tmpdir(), 'shl-pdf-'));

  try {
    // Use macOS qlmanage to render PDF pages as images
    const size = Math.round(1000 * pdfScanScale);
    execFileSync('qlmanage', ['-t', '-s', String(size), '-o', tmpDir, filePath], {
      stdio: 'pipe',
      timeout: 30_000,
    });

    // qlmanage creates files like "filename.pdf.png" in the tmp dir
    const images = readdirSync(tmpDir)
      .filter((f) => /\.(png|jpg|jpeg|tiff)$/i.test(f))
      .slice(0, pdfMaxPages)
      .map((f) => join(tmpDir, f));

    for (const imgPath of images) {
      const result = await readQrFromImage(imgPath);
      if (result) return result;
    }

    return null;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
