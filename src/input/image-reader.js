import sharp from 'sharp';
import jsQR from 'jsqr';

/**
 * Read a QR code from an image file (PNG, JPG, WEBP, TIFF).
 * Returns the decoded QR string or null if no QR found.
 */
export async function readQrFromImage(filePath) {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const imageData = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const code = jsQR(imageData, info.width, info.height);
  return code?.data ?? null;
}
