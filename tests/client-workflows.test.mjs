import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function element() {
  const handlers = new Map();
  return {
    fields: new Map(), dataset: {}, value: '', hidden: false, disabled: false,
    classList: { toggle() {} }, style: {},
    addEventListener(type, handler) { const list = handlers.get(type) ?? []; list.push(handler); handlers.set(type, list); },
    async emit(type, event = {}) { await Promise.all((handlers.get(type) ?? []).map((fn) => fn(event))); },
    setAttribute() {}, removeAttribute() {}, contains: () => false, focus() {}, querySelector: () => null,
  };
}
class FormDataDouble extends FormData {
  constructor(form) { super(); for (const [key, value] of form?.fields ?? []) this.set(key, value); }
}
function script(path) {
  const source = readFileSync(path, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}
function specialsClient() {
  const weekly = element(), recurring = element(), picker = element(), save = element();
  weekly.fields.set('weekly_id', '1');
  weekly.fields.set('week_start_date', '2026-09-07');
  recurring.fields.set('recurring_daily_sandwich', 'Original');
  weekly.querySelector = (selector) => selector.includes('save-weekly-specials') ? save : selector.includes('weekly_id') ? { value: '1' } : null;
  recurring.querySelector = () => element();
  const cards = Array.from({ length: 7 }, (_, i) => ({ ...element(), dataset: { dayName: String(i) } }));
  const buttons = Array.from({ length: 7 }, element);
  const doc = element(), win = element();
  const prompts = [];
  let accept = false, fetchHandler = async () => Response.json({ ok: true });
  const ids = { 'weekly-form': weekly, 'recurring-defaults-form': recurring, 'saved-week': picker };
  doc.getElementById = (id) => ids[id] ?? null;
  doc.querySelectorAll = (selector) => selector === '.day-fields' ? cards : selector === '[data-day-select]' ? buttons : [];
  win.matchMedia = () => ({ matches: true, addEventListener() {} });
  win.confirm = (message) => { prompts.push(message); return accept; };
  const location = new URL('https://example.com/admin/specials');
  vm.runInNewContext(script('src/pages/admin/specials.astro'), {
    document: doc, window: win, location, FormData: FormDataDouble, URL, Event,
    requestAnimationFrame: () => {}, fetch: (...args) => fetchHandler(...args),
  });
  return { weekly, recurring, picker, save, cards, buttons, win, doc, prompts, location,
    accept: (value) => { accept = value; }, fetch: (fn) => { fetchHandler = fn; } };
}
function event(extra = {}) { return { prevented: false, preventDefault() { this.prevented = true; }, ...extra }; }

test('recurring-only edits warn on week change, links, and unload; successful save clears only recurring dirtiness', async () => {
  const f = specialsClient();
  f.recurring.fields.set('recurring_daily_sandwich', 'Changed');
  await f.recurring.emit('input');
  f.picker.value = '2';
  await f.picker.emit('change');
  assert.equal(f.picker.value, '');
  assert.match(f.prompts[0], /Recurring Defaults/);
  const link = { href: 'https://example.com/', protocol: 'https:', target: '', hasAttribute: () => false };
  const click = event({ target: { closest: () => link } });
  await f.doc.emit('click', click);
  assert.equal(click.prevented, true);
  const unload = event(); await f.win.emit('beforeunload', unload);
  assert.equal(unload.prevented, true);
  await f.recurring.emit('submit', event());
  const cleanUnload = event(); await f.win.emit('beforeunload', cleanUnload);
  assert.equal(cleanUnload.prevented, false);
  f.weekly.fields.set('lunch_0', 'Weekly draft'); await f.weekly.emit('input');
  await f.recurring.emit('submit', event());
  const weeklyUnload = event(); await f.win.emit('beforeunload', weeklyUnload);
  assert.equal(weeklyUnload.prevented, true);
});

test('failed recurring save and edits made during a successful request remain dirty', async () => {
  const f = specialsClient();
  f.recurring.fields.set('recurring_daily_sandwich', 'First edit'); await f.recurring.emit('input');
  f.fetch(async () => Response.json({ ok: false }, { status: 500 }));
  await f.recurring.emit('submit', event());
  const failed = event(); await f.win.emit('beforeunload', failed); assert.equal(failed.prevented, true);
  let finish;
  f.fetch(() => new Promise((resolve) => { finish = resolve; }));
  const saving = f.recurring.emit('submit', event());
  f.recurring.fields.set('recurring_daily_sandwich', 'Edit during save'); await f.recurring.emit('input');
  finish(Response.json({ ok: true })); await saving;
  const changed = event(); await f.win.emit('beforeunload', changed); assert.equal(changed.prevented, true);
});

test('mobile can jump directly to Sunday; weekly save gating and retained edits are unchanged', async () => {
  const f = specialsClient();
  assert.equal(f.save.disabled, true);
  f.weekly.fields.set('lunch_0', 'Keep this draft'); await f.weekly.emit('input');
  assert.equal(f.save.disabled, true);
  await f.buttons[6].emit('click');
  assert.equal(f.save.disabled, false);
  assert.equal(f.cards[0].hidden, true);
  assert.equal(f.cards[6].hidden, false);
  assert.equal(f.weekly.fields.get('lunch_0'), 'Keep this draft');
  const saving = event(); await f.weekly.emit('submit', saving); assert.equal(saving.prevented, false);
});

test('weekly save warns before discarding unsaved recurring defaults', async () => {
  const f = specialsClient();
  f.weekly.fields.set('lunch_0', 'Weekly draft'); await f.weekly.emit('input');
  await f.buttons[6].emit('click');
  f.recurring.fields.set('recurring_daily_sandwich', 'Unsaved'); await f.recurring.emit('input');
  const cancelled = event(); await f.weekly.emit('submit', cancelled); assert.equal(cancelled.prevented, true);
  f.accept(true);
  const accepted = event(); await f.weekly.emit('submit', accepted); assert.equal(accepted.prevented, false);
});

test('contact resets Turnstile after failure and success without losing failed input', async () => {
  const form = element(), status = element(), button = element();
  form.fields.set('message', 'Keep on failure');
  form.querySelector = () => button;
  let resets = 0, clears = 0, success = false;
  form.reset = () => { clears++; };
  vm.runInNewContext(script('src/pages/contact.astro'), {
    document: { getElementById: (id) => id === 'contactForm' ? form : status },
    window: { turnstile: { reset: (selector) => { assert.equal(selector, '#contact-turnstile'); resets++; } } },
    FormData: FormDataDouble,
    fetch: async () => { if (!success) throw new Error('Network failed'); return Response.json({ ok: true }); },
  });
  await form.emit('submit', event());
  assert.equal(resets, 1); assert.equal(clears, 0); assert.equal(button.disabled, false);
  success = true; await form.emit('submit', event());
  assert.equal(resets, 2); assert.equal(clears, 1); assert.equal(button.disabled, false);
});
