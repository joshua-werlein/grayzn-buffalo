export const UPLOAD_MESSAGES = {
  submitted: 'Thanks for sharing! Your photos are pending staff review.',
  duplicate: 'At least one photo was already submitted. Remove the duplicate and try again.',
  'invalid-form': 'Choose up to three photos, describe each selected photo, choose a category, and confirm permission.',
  'invalid-photo': 'A photo could not be processed. Try a different JPEG, PNG, or WebP, up to 24 megapixels.',
  'too-large': 'Use photos that are 5 MB or smaller and try again.',
  verification: 'Verification failed or expired. Wait for it to finish, then submit again.',
  'stale-form': 'This form has expired. Refresh the page before submitting again.',
  session: 'Staff access is unavailable. Sign in again from Staff login, then reopen this form.',
  unavailable: 'The upload could not be confirmed. Check the pending queue before trying again.',
  network: 'The connection was interrupted. Check the pending queue before trying again.',
  sending: 'Uploading and processing photos…',
} as const;

export function uploadMessage(code: string): string {
  return Object.hasOwn(UPLOAD_MESSAGES, code) ? UPLOAD_MESSAGES[code as keyof typeof UPLOAD_MESSAGES] : '';
}

export async function uploadResult(response: Response): Promise<string> {
  if (response.status === 413) return 'too-large';
  if (response.status === 401 || response.status === 404) return 'session';
  const json = response.headers.get('content-type')?.includes('application/json')
    ? await response.json().catch(() => null)
    : null;
  const code = json?.code;
  if (response.status === 201 && code === 'submitted') return code;
  if (!response.ok && typeof code === 'string' && uploadMessage(code) && !['submitted', 'sending'].includes(code)) return code;
  return response.status === 403 ? 'stale-form' : 'unavailable';
}
