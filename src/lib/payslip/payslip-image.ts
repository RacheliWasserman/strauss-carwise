import { PAYSLIP_LIMITS } from './payslip-contract';
import { PayslipFileError } from './payslip-file';

/**
 * Decodes the image (rejecting corrupt or oversized files), applies the camera's rotation, and re-encodes a
 * bounded JPEG. Re-encoding drops all metadata (camera, time, GPS location), so only the pixels are ever sent.
 */
export async function normalizeImage(bytes: Uint8Array) {
  const sharp = (await import('sharp')).default;
  let width = 0;
  let height = 0;
  let data: Buffer;
  try {
    const image = sharp(bytes, { limitInputPixels: PAYSLIP_LIMITS.maxImagePixels, failOn: 'error', sequentialRead: true, animated: false });
    const meta = await image.metadata();
    if (!meta.width || !meta.height) throw new PayslipFileError('invalid_image');
    // EXIF orientations 5-8 swap the visible width and height.
    const swapped = (meta.orientation ?? 1) >= 5;
    width = swapped ? meta.height : meta.width;
    height = swapped ? meta.width : meta.height;
    data = await image.rotate().resize({ width: 2200, height: 2200, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 85, mozjpeg: false }).toBuffer();
  } catch (error) {
    if (error instanceof PayslipFileError) throw error;
    throw new PayslipFileError(error instanceof Error && /pixel limit/i.test(error.message) ? 'image_too_large' : 'invalid_image');
  }
  const warnings: string[] = [];
  if (Math.min(width, height) < 700) warnings.push('התמונה ברזולוציה נמוכה, ולכן ייתכנו טעויות בקריאה. כדאי לבדוק כל ערך.');
  return { data, mimeType: 'image/jpeg' as const, warnings };
}
