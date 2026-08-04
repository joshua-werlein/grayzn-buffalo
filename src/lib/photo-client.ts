/** Runs in the browser only. Converts a phone photo to two webp blobs. */
export class PhotoError extends Error {}

export type PhotoOrientation = 'portrait' | 'square' | 'landscape';
export type Converted = { full: Blob; thumb: Blob; width: number; height: number; orientation: PhotoOrientation };

const MAX_INPUT_BYTES = 12 * 1024 * 1024;
// Food photography remains crisp at this level while uploads are materially
// smaller than the previous 0.82 setting.
const QUALITY = 0.74;

export async function convertPhoto(file: File, rotation = 0): Promise<Converted> {
  if (!file.type.startsWith('image/')) {
    throw new PhotoError('That file is not an image.');
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new PhotoError('That photo is too large to read. Try a screenshot of it instead.');
  }

  const exifOrientation = await readExifOrientation(file);
  const decoded = await decode(file);
  const src = decoded.src;
  try {
    const normalized = normalizeRotation(rotation);
    // ImageBitmap gives us the raw sensor pixels. Apply EXIF here so the
    // canvas writes correctly oriented, metadata-free WebP files to R2.
    const sourceOrientation = decoded.exifAlreadyApplied ? 1 : exifOrientation;
    const full = await resize(src, 1200, normalized, sourceOrientation);
    const thumb = await resize(src, 600, normalized, sourceOrientation);
    const sourceWidth = 'naturalWidth' in src ? src.naturalWidth : src.width;
    const sourceHeight = 'naturalHeight' in src ? src.naturalHeight : src.height;
    const exifSwapsAxes = [5, 6, 7, 8].includes(sourceOrientation);
    const exifWidth = exifSwapsAxes ? sourceHeight : sourceWidth;
    const exifHeight = exifSwapsAxes ? sourceWidth : sourceHeight;
    const quarterTurn = Math.abs(normalized) === 90;
    const width = quarterTurn ? exifHeight : exifWidth;
    const height = quarterTurn ? exifWidth : exifHeight;

    return {
      full,
      thumb,
      width,
      height,
      orientation: classifyOrientation(width, height),
    };
  } finally {
    if ('close' in src) src.close();
  }
}

type Source = ImageBitmap | HTMLImageElement;
type Decoded = { src: Source; exifAlreadyApplied: boolean };

function normalizeRotation(value: number) {
  const normalized = ((value % 360) + 360) % 360;
  if (normalized === 270) return -90;
  if (normalized === 0 || normalized === 90 || normalized === 180) return normalized;
  throw new PhotoError('That rotation is not supported.');
}

async function decode(file: File): Promise<Decoded> {
  try {
    return { src: await createImageBitmap(file, { imageOrientation: 'none' }), exifAlreadyApplied: false };
  } catch { /* older Safari, or a format it cannot decode */ }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // HTMLImageElement decoders apply EXIF orientation themselves. Do not
    // apply it a second time in the canvas fallback path.
    return { src: img, exifAlreadyApplied: true };
  } catch {
    throw new PhotoError("Couldn't read that photo — try taking a screenshot of it and uploading that.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function resize(src: Source, targetWidth: number, rotation: number, exifOrientation: number): Promise<Blob> {
  const sw = 'naturalWidth' in src ? src.naturalWidth : src.width;
  const sh = 'naturalHeight' in src ? src.naturalHeight : src.height;
  const exifSwapsAxes = [5, 6, 7, 8].includes(exifOrientation);
  const orientedWidth = exifSwapsAxes ? sh : sw;
  const orientedHeight = exifSwapsAxes ? sw : sh;
  const quarterTurn = Math.abs(rotation) === 90;
  const rotatedWidth = quarterTurn ? orientedHeight : orientedWidth;
  const rotatedHeight = quarterTurn ? orientedWidth : orientedHeight;
  const scale = Math.min(1, targetWidth / rotatedWidth);
  const w = Math.max(1, Math.round(rotatedWidth * scale));
  const h = Math.max(1, Math.round(rotatedHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new PhotoError('Your browser could not process that photo.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(w / 2, h / 2);
  ctx.rotate(rotation * Math.PI / 180);
  ctx.scale(scale, scale);
  ctx.translate(-orientedWidth / 2, -orientedHeight / 2);
  applyExifOrientation(ctx, exifOrientation, sw, sh);
  ctx.drawImage(src as CanvasImageSource, 0, 0, sw, sh);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', QUALITY));
  if (!blob) throw new PhotoError('Your browser could not process that photo.');
  if (blob.type !== 'image/webp') {
    throw new PhotoError('Your browser cannot save webp images. Try Chrome, Edge, or an up-to-date Safari.');
  }
  return blob;
}

function classifyOrientation(width: number, height: number): PhotoOrientation {
  if (width > height * 1.1) return 'landscape';
  if (height > width * 1.1) return 'portrait';
  return 'square';
}

function applyExifOrientation(ctx: CanvasRenderingContext2D, orientation: number, sw: number, sh: number) {
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, sw, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, sw, sh); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, sh); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, sh, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, sh, sw); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, sw); break;
  }
}

async function readExifOrientation(file: File): Promise<number> {
  if (!/image\/jpe?g/i.test(file.type)) return 1;
  try {
    const bytes = new DataView(await file.slice(0, 128 * 1024).arrayBuffer());
    if (bytes.byteLength < 12 || bytes.getUint16(0, false) !== 0xffd8) return 1;
    let offset = 2;
    while (offset + 4 <= bytes.byteLength) {
      if (bytes.getUint8(offset) !== 0xff) break;
      const marker = bytes.getUint8(offset + 1);
      const length = bytes.getUint16(offset + 2, false);
      if (length < 2 || offset + 2 + length > bytes.byteLength) break;
      if (marker === 0xe1 && bytes.getUint32(offset + 4, false) === 0x45786966 && bytes.getUint16(offset + 8, false) === 0) {
        const tiff = offset + 10;
        const littleEndian = bytes.getUint16(tiff, false) === 0x4949;
        if (bytes.getUint16(tiff + 2, littleEndian) !== 0x002a) return 1;
        const ifd = tiff + bytes.getUint32(tiff + 4, littleEndian);
        const count = bytes.getUint16(ifd, littleEndian);
        for (let index = 0; index < count; index += 1) {
          const entry = ifd + 2 + index * 12;
          if (entry + 12 > bytes.byteLength) return 1;
          if (bytes.getUint16(entry, littleEndian) === 0x0112) {
            const orientation = bytes.getUint16(entry + 8, littleEndian);
            return orientation >= 1 && orientation <= 8 ? orientation : 1;
          }
        }
      }
      offset += 2 + length;
    }
  } catch {}
  return 1;
}
