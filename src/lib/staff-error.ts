// Staff pages show their own validation and conflict messages. Unexpected
// failures (database, storage, runtime) can carry SQL, schema, binding or code
// details, so those are replaced by the page's generic message. Same rule as the
// automation approval, dismissal and Wing endpoints.
const INTERNAL = /SQL|D1_|sqlite|database|no such|constraint|internal error|network connection/i;

export function staffErrorMessage(error: unknown, fallback: string): string {
  // Runtime faults (TypeError and similar) describe code, never staff input.
  if (!(error instanceof Error) || error instanceof TypeError || error instanceof ReferenceError
      || error instanceof SyntaxError || error instanceof RangeError) return fallback;
  const message = error.message.trim();
  return message && message.length <= 400 && !INTERNAL.test(message) ? message : fallback;
}
