/** Runs in the browser only. Converts a phone photo to two webp blobs. */

export class PhotoError extends Error {}

export type Converted = { full: Blob; thumb: Blob; width: number; height: number };

const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const QUALITY = 0.82;

export async function convertPhoto(file: File): Promise<Converted> {
  if (!file.type.startsWith('image/')) {
    throw new PhotoError('That file is not an image.');
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new PhotoError('That photo is too large to read. Try a screenshot of it instead.');
  }

  const src = await decode(file);
  try {
    const full = await resize(src, 1200);
    const thumb = await resize(src, 600);
    return { full, thumb, width: src.width, height: src.height };
  } finally {
    if ('close' in src) src.close();
  }
}

type Source = ImageBitmap | HTMLImageElement;

async function decode(file: File): Promise<Source> {
  // Preferred path: applies EXIF orientation, hands back a bitmap.
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch { /* older Safari, or a format it can't decode */ }

  // Fallback: <img> applies EXIF orientation natively in current browsers.
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

async function resize(src: Source, targetWidth: number): Promise<Blob> {
  const sw = 'naturalWidth' in src ? src.naturalWidth : src.width;
  const sh = 'naturalHeight' in src ? src.naturalHeight : src.height;

  const scale = Math.min(1, targetWidth / sw);   // never upscale
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new PhotoError('Your browser could not process that photo.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src as CanvasImageSource, 0, 0, w, h);

  const blob = await new Promise<Blob | null>((res) =>
    canvas.toBlob(res, 'image/webp', QUALITY)
  );
  if (!blob) throw new PhotoError('Your browser could not process that photo.');

  // toBlob silently falls back to PNG where webp encoding is missing.
  // Catch it — otherwise we upload a 2 MB PNG under a .webp key.
  if (blob.type !== 'image/webp') {
    throw new PhotoError('Your browser cannot save webp images. Try Chrome, Edge, or an up-to-date Safari.');
  }
  return blob;
}