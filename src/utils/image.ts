/**
 * Server-side image inspection (Phase 10B). Detects the real image type from
 * magic bytes (never the client MIME/extension) and reads pixel dimensions
 * from the file header to bound decompression-bomb risk — WITHOUT decoding the
 * whole image. Supports the JPEG/PNG/WebP set the app already accepts.
 */
export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface ImageInfo {
  mime: ImageMime;
  width: number;
  height: number;
}

/** Total-pixel cap (~25 MP) — well above a phone photo, far below a bomb. */
export const MAX_IMAGE_PIXELS = 25_000_000;
/** Per-dimension cap. */
export const MAX_IMAGE_DIMENSION = 12_000;

function detectMime(buf: Buffer): ImageMime | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp';
  return null;
}

function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  // IHDR width/height are big-endian uint32 at offsets 16 and 20.
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  // Walk the JPEG marker segments to the SOFn frame header.
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    // SOF0..SOF15 (excluding DHT 0xc4, JPG 0xc8, DAC 0xcc) carry dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    // Standalone markers without a length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = buf.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
}

function webpDimensions(buf: Buffer): { width: number; height: number } | null {
  // RIFF....WEBP<format>. Handle VP8 (lossy), VP8L (lossless), VP8X (extended).
  if (buf.length < 30) return null;
  const format = buf.subarray(12, 16).toString('ascii');
  if (format === 'VP8 ') {
    // 0x9d012a signature then 14-bit width/height.
    const w = buf.readUInt16LE(26) & 0x3fff;
    const h = buf.readUInt16LE(28) & 0x3fff;
    return { width: w, height: h };
  }
  if (format === 'VP8L') {
    const b = buf.subarray(21, 26);
    const bits = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (format === 'VP8X') {
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height };
  }
  return null;
}

/**
 * Validates that the buffer is a supported image within the pixel bounds and
 * returns the detected type + dimensions. Returns null when the bytes are not
 * a recognized image (caller maps this to INVALID_FILE_TYPE).
 */
export function inspectImage(buf: Buffer): ImageInfo | { error: 'INVALID_FILE_TYPE' | 'IMAGE_TOO_LARGE' } {
  const mime = detectMime(buf);
  if (!mime) return { error: 'INVALID_FILE_TYPE' };

  const dims =
    mime === 'image/png' ? pngDimensions(buf) : mime === 'image/jpeg' ? jpegDimensions(buf) : webpDimensions(buf);
  if (!dims || dims.width <= 0 || dims.height <= 0) {
    // Unreadable header for a claimed image type → reject as invalid.
    return { error: 'INVALID_FILE_TYPE' };
  }
  if (
    dims.width > MAX_IMAGE_DIMENSION ||
    dims.height > MAX_IMAGE_DIMENSION ||
    dims.width * dims.height > MAX_IMAGE_PIXELS
  ) {
    return { error: 'IMAGE_TOO_LARGE' };
  }
  return { mime, width: dims.width, height: dims.height };
}
