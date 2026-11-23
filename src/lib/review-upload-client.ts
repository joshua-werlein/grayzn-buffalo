import { uploadMessage, uploadResult } from './review-feedback';

export function connectReviewUpload(doc: Document) {
  const form = doc.querySelector<HTMLFormElement>('[data-review-upload]');
  const fallback = doc.querySelector<HTMLElement>('[data-upload-fallback]');
  const view = doc.defaultView;
  if (fallback && view?.location.hash === '#submit-photo') fallback.focus();
  if (!form || !view) return;

  const status = form.querySelector<HTMLElement>('[data-upload-status]')!;
  const error = form.querySelector<HTMLElement>('[data-upload-error]')!;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  let sending = false;

  function show(code: string, focus: boolean) {
    const target = code === 'submitted' || code === 'sending' ? status : error;
    status.textContent = '';
    error.textContent = '';
    target.textContent = uploadMessage(code);
    if (fallback) fallback.hidden = true;
    if (focus) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    }
  }

  form.addEventListener('invalid', () => show('invalid-form', false), true);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending) return;

    const body = new FormData(form);
    if (body.getAll('photo').some(file => file instanceof File && file.size > 5 * 1024 * 1024)) {
      show('too-large', true);
      return;
    }
    if (!body.get('cf-turnstile-response')) {
      show('verification', true);
      return;
    }

    sending = true;
    submit.disabled = true;
    show('sending', false);
    let code: string;
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(90000),
      });
      code = await uploadResult(response);
    } catch {
      code = 'network';
    } finally {
      sending = false;
      submit.disabled = false;
    }
    if (code === 'submitted') form.reset();
    show(code, true);
    const widget = form.querySelector<HTMLElement>('.cf-turnstile');
    (view as Window & { turnstile?: { reset(widget: HTMLElement): void } }).turnstile?.reset(widget!);
  });
}
