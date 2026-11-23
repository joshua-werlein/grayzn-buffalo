import { isWebpUpload } from './photo-upload';
import { reviewObjectKey } from './review-preview';

export const MAX_REVIEW_PHOTOS = 3;
export const MAX_REVIEW_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_REVIEW_REQUEST_BYTES = MAX_REVIEW_PHOTOS * MAX_REVIEW_PHOTO_BYTES + 32 * 1024;
const MAX_PIXELS = 24_000_000;
const VARIANTS = { small: 320, medium: 640, large: 1440 } as const;

export class InvalidReviewImage extends Error {
  constructor(readonly stage = 'image-output') {
    super('Invalid review image');
  }
}

function mimeMatches(buffer: ArrayBuffer, type: string): boolean {
  const bytes = new Uint8Array(buffer);
  if (type === 'image/jpeg') {
    return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  }
  if (type === 'image/png') {
    return bytes.length >= 20 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)
      && [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130].every((byte, i) => bytes[bytes.length - 12 + i] === byte);
  }
  return type === 'image/webp' && isWebpUpload(buffer);
}

/** Copy only the chunks that carry still-image pixels and dimensions. Drop
 * all auxiliary chunks, including EXIF, XMP, ICC profiles and arbitrary data. */
function safeWebp(buffer: ArrayBuffer) {
  if (!isWebpUpload(buffer)) throw new InvalidReviewImage();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const output = new Uint8Array(bytes.length);
  output.set(bytes.subarray(0, 12));
  let end = 12;
  let width = 0;
  let height = 0;
  let canvasWidth = 0;
  let canvasHeight = 0;
  const seen = new Set<string>();
  for (let pos = 12; pos < bytes.length;) {
    if (pos + 8 > bytes.length) throw new InvalidReviewImage();
    const tag = String.fromCharCode(...bytes.subarray(pos, pos + 4));
    const length = view.getUint32(pos + 4, true);
    const payload = pos + 8;
    const next = payload + length + (length % 2);
    if (next > bytes.length) throw new InvalidReviewImage();

    if (['VP8X', 'ALPH', 'VP8 ', 'VP8L'].includes(tag)) {
      if (seen.has(tag)) throw new InvalidReviewImage();
      seen.add(tag);
      output.set(bytes.subarray(pos, next), end);
      if (tag === 'VP8X') {
        if (length !== 10 || (bytes[payload] & 2) !== 0) throw new InvalidReviewImage();
        output[end + 8] &= 16; // Keep the alpha flag only.
        canvasWidth = (view.getUint32(payload + 4, true) & 0xffffff) + 1;
        canvasHeight = (bytes[payload + 7] | bytes[payload + 8] << 8 | bytes[payload + 9] << 16) + 1;
      } else if (tag === 'VP8 ') {
        if (length < 10 || (bytes[payload] & 1) || bytes[payload + 3] !== 157
            || bytes[payload + 4] !== 1 || bytes[payload + 5] !== 42) throw new InvalidReviewImage();
        width = view.getUint16(payload + 6, true) & 0x3fff;
        height = view.getUint16(payload + 8, true) & 0x3fff;
      } else if (tag === 'VP8L') {
        if (length < 5 || bytes[payload] !== 47) throw new InvalidReviewImage();
        const dimensions = view.getUint32(payload + 1, true);
        width = (dimensions & 0x3fff) + 1;
        height = ((dimensions >>> 14) & 0x3fff) + 1;
      }
      if (length % 2) output[end + next - pos - 1] = 0;
      end += next - pos;
    }
    pos = next;
  }
  if (seen.has('VP8 ') === seen.has('VP8L') || !width || !height
      || (canvasWidth && (width !== canvasWidth || height !== canvasHeight))) throw new InvalidReviewImage();
  new DataView(output.buffer).setUint32(4, end - 8, true);
  return { bytes: output.slice(0, end), width, height };
}

const imageStream = (bytes: ArrayBuffer) => new Blob([bytes]).stream();

export async function prepareReviewImage(file: File, images: any) {
  const original = await file.arrayBuffer();
  if (!mimeMatches(original, file.type)) throw new InvalidReviewImage('image-signature');

  let stage = 'image-info';
  try {
    const info = await images.info(imageStream(original));
    if (info.format !== file.type || !Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height)
        || info.width <= 0 || info.height <= 0 || info.width * info.height > MAX_PIXELS) throw new InvalidReviewImage();

    stage = 'image-transform';
    const resize = async (limit: number) => {
      const result = await images.input(imageStream(original))
        .transform({ width: limit, height: limit, fit: 'scale-down' })
        .output({ format: 'image/webp', quality: 82, anim: false });
      const response = result.response();
      if (!response.ok) throw new InvalidReviewImage();
      const image = safeWebp(await response.arrayBuffer());
      if (image.width > limit || image.height > limit) throw new InvalidReviewImage();
      return image;
    };

    const large = await resize(VARIANTS.large);
    const medium = Math.max(large.width, large.height) <= VARIANTS.medium ? large : await resize(VARIANTS.medium);
    const small = Math.max(medium.width, medium.height) <= VARIANTS.small ? medium : await resize(VARIANTS.small);
    const digestBytes = await crypto.subtle.digest('SHA-256', large.bytes);
    const digest = Array.from(new Uint8Array(digestBytes), byte => byte.toString(16).padStart(2, '0')).join('');
    return { original, digest, large, medium, small };
  } catch {
    throw new InvalidReviewImage(stage);
  }
}

export async function storeReviewImage(bucket: any, id: string, image: Awaited<ReturnType<typeof prepareReviewImage>>) {
  await bucket.put(reviewObjectKey(id, 'original'), image.original, {
    httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'no-store' },
  });
  for (const size of ['small', 'medium', 'large'] as const) {
    await bucket.put(reviewObjectKey(id, size), image[size].bytes, {
      httpMetadata: { contentType: 'image/webp', cacheControl: 'no-store' },
    });
  }
}

export async function discardReviewImage(bucket: any, id: string) {
  await bucket.delete((['original', 'small', 'medium', 'large'] as const).map(size => reviewObjectKey(id, size)));
}
