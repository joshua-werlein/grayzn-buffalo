// Bounded request-body reads. request.json()/formData()/text() buffer the whole
// body before any field check, so an oversized or never-ending body costs memory
// and time first. These readers stop at a byte limit, whether or not the client
// sent Content-Length, and whether that header is honest.

export class BodyTooLarge extends Error {
  constructor() { super('Request is too large.'); this.name = 'BodyTooLarge'; }
}

/** Reads at most `limit` bytes, or throws BodyTooLarge without reading further. */
export async function readBodyBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > limit) {
    await request.body?.cancel().catch(() => {});
    throw new BodyTooLarge();
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export const readBodyText = async (request: Request, limit: number) =>
  new TextDecoder().decode(await readBodyBytes(request, limit));

/** The same FormData request.formData() returns, after a bounded read. */
export async function readFormData(request: Request, limit: number): Promise<FormData> {
  const bytes = await readBodyBytes(request, limit);
  const type = request.headers.get('content-type');
  return new Response(bytes, type ? { headers: { 'content-type': type } } : undefined).formData();
}

// Staff form posts carry at most a week of specials or one menu options panel:
// tens of kilobytes. Photo uploads have their own, larger limit.
export const STAFF_FORM_LIMIT = 512 * 1024;

/** The response for a body that was too large or could not be parsed. */
export function rejectedBody(error: unknown, json = false): Response {
  const status = error instanceof BodyTooLarge ? 413 : 400;
  const message = status === 413 ? 'This request is too large. Nothing was saved.' : 'This request could not be read. Nothing was saved.';
  const headers = { 'cache-control': 'no-store' };
  return json ? Response.json({ ok: false, error: message }, { status, headers })
    : new Response(message, { status, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
}
