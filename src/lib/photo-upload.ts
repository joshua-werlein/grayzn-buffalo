/** Check the WebP container before storing client-converted photo bytes.
 * This is a signature/length check, not a complete image decoder. */
export function isWebpUpload(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 20) return false;
  const bytes = new Uint8Array(buffer);
  const text = (start: number) => String.fromCharCode(...bytes.subarray(start, start + 4));
  const view = new DataView(buffer);
  return text(0) === 'RIFF' && text(8) === 'WEBP'
    && view.getUint32(4, true) === buffer.byteLength - 8
    && ['VP8 ', 'VP8L', 'VP8X'].includes(text(12))
    && view.getUint32(16, true) > 0
    && view.getUint32(16, true) <= buffer.byteLength - 20;
}
