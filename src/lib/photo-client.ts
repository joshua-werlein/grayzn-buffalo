/** Runs in the browser only. Converts a phone photo to two webp blobs. */
export class PhotoError extends Error {}

export type Converted = { full: Blob; thumb: Blob; width: number; height: number };

const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const QUALITY = 0.82;

export async function convertPhoto(file: File, rotation = 0): Promise<Converted> {
  if (!file.type.startsWith('image/')) {
    throw new PhotoError('That file is not an image.');
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new PhotoError('That photo is too large to read. Try a screenshot of it instead.');
  }

  const src = await decode(file);
  try {
    const normalized = normalizeRotation(rotation);
    const full = await resize(src, 1200, normalized);
    const thumb = await resize(src, 600, normalized);
    const sourceWidth = 'naturalWidth' in src ? src.naturalWidth : src.width;
    const sourceHeight = 'naturalHeight' in src ? src.naturalHeight : src.height;
    const quarterTurn = Math.abs(normalized) === 90;

    return {
      full,
      thumb,
      width: quarterTurn ? sourceHeight : sourceWidth,
      height: quarterTurn ? sourceWidth : sourceHeight,
    };
  } finally {
    if ('close' in src) src.close();
  }
}

type Source = ImageBitmap | HTMLImageElement;

function normalizeRotation(value: number) {
  const normalized = ((value % 360) + 360) % 360;
  if (normalized === 270) return -90;
  if (normalized === 0 || normalized === 90 || normalized === 180) return normalized;
  throw new PhotoError('That rotation is not supported.');
}

async function decode(file: File): Promise<Source> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch { /* older Safari, or a format it cannot decode */ }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new PhotoError("Couldn't read that photo — try taking a screenshot of it and uploading that.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function resize(src: Source, targetWidth: number, rotation: number): Promise<Blob> {
  const sw = 'naturalWidth' in src ? src.naturalWidth : src.width;
  const sh = 'naturalHeight' in src ? src.naturalHeight : src.height;
  const quarterTurn = Math.abs(rotation) === 90;
  const rotatedWidth = quarterTurn ? sh : sw;
  const rotatedHeight = quarterTurn ? sw : sh;
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

  const drawWidth = sw * scale;
  const drawHeight = sh * scale;
  ctx.drawImage(src as CanvasImageSource, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', QUALITY));
  if (!blob) throw new PhotoError('Your browser could not process that photo.');
  if (blob.type !== 'image/webp') {
    throw new PhotoError('Your browser cannot save webp images. Try Chrome, Edge, or an up-to-date Safari.');
  }
  return blob;
}