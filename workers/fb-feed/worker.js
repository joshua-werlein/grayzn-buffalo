import {buildExtractionRequest, buildWeeklyLunchExtractionRequest, buildMexicanNightExtractionRequest} from './extraction.js';
import { classifyCaption, PARSER_VERSION } from './classify.js';
import { reconcileToday, pruneImportHistory, reconcileWeeklyLunch, reconcileMexicanNight } from './guarded-auto.js';
import {ensureAutomaticWeek} from './auto-week.js';
import {MAX_IMPORT_ATTEMPTS,OWNS_ATTEMPT_SQL,isTransientFailure,claimImportAttempt,attemptEvent,saveAttemptImage,finishImportAttempt,retireImportAttempts} from './recovery.js';
import {validateEvidence, validateWeeklyLunch, validateMexicanNight, singleDayLunchEvidence, WEEKLY_LUNCH_SHAPE_ERROR, MEXICAN_NIGHT_SHAPE_ERROR, WEEKDAY_ENCODING_MISMATCH} from './reconcile.js';
import {WEBHOOK_PATH, handleFacebookWebhook} from './webhook.js';

const TIME_ZONE = 'America/Chicago';
const GRAPH_API_VERSION = 'v26.0';
const FEED_KEY = 'fb:feed';
const MAX_POSTS = 4;
// Retain retired media beyond the four-day public stale limit, plus a buffer
// for KV propagation and the endpoint's 60-second edge/browser cache.
const IMAGE_RETENTION_MS = (4 * 24 * 60 * 60 + 5 * 60) * 1000;

const RESPONSE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};

const datePartsFormatter = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const displayDateFormatter = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric' });
const hourFormatter = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', hour12: false });

function chicagoDateParts(value = new Date()) {
  return Object.fromEntries(datePartsFormatter.formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}
function chicagoDate(value = new Date()) {
  const { year, month, day } = chicagoDateParts(value);
  return `${year}-${month}-${day}`;
}
function chicagoCalendarOffset(value, offset) {
  const { year, month, day } = chicagoDateParts(value);
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + offset)).toISOString().slice(0, 10);
}
function postedLabel(createdTime, now = new Date()) {
  const postDate = chicagoDate(new Date(createdTime));
  if (postDate === chicagoDate(now)) return 'Posted today';
  if (postDate === chicagoCalendarOffset(now, -1)) return 'Posted yesterday';
  return `Posted ${displayDateFormatter.format(new Date(createdTime))}`;
}
function cleanMessage(value) {
  if (typeof value !== 'string') return '';
  // Graph API messages are normally clean, but never surface a trailing UI affordance
  // if Meta includes one in a future response shape.
  return value.replace(/(?:\r?\n)?(?:See more|See less)\s*$/i, '').trim();
}
const IMAGE_FORMATS = {
  'image/jpeg': { extension: 'jpg', contentType: 'image/jpeg' },
  'image/png': { extension: 'png', contentType: 'image/png' },
  'image/webp': { extension: 'webp', contentType: 'image/webp' },
  'image/gif': { extension: 'gif', contentType: 'image/gif' },
};

export function imageFormat(contentType) {
  const normalized = typeof contentType === 'string' ? contentType.split(';', 1)[0].trim().toLowerCase() : '';
  return IMAGE_FORMATS[normalized] ?? {
    extension: 'bin',
    contentType: normalized.startsWith('image/') ? normalized : 'application/octet-stream',
  };
}

function normalizedImageUrl(value) {
  try {
    const url = new URL(value);
    // Facebook CDN query strings can be transient. The path is the more
    // stable fallback identity when Graph does not provide updated_time.
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value ?? '');
  }
}

export function imageSourceVersion(post) {
  if (typeof post.updated_time === 'string' && post.updated_time) return `updated:${post.updated_time}`;
  return `image:${normalizedImageUrl(post.full_picture)}`;
}

export function shouldRefreshImage(post, previousPost) {
  if (!post.full_picture) return false;
  if (!imageKeyFromPost(previousPost ?? {})) return true;
  return previousPost?.imageSourceVersion !== imageSourceVersion(post);
}

async function versionToken(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).slice(0, 10).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function imageKey(postId, token, extension) {
  return `facebook/${postId.replace(/[^A-Za-z0-9_-]/g, '_')}-${token}.${extension}`;
}
function imageKeyFromPost(post) {
  if (typeof post.imageKey === 'string' && post.imageKey.startsWith('facebook/')) return post.imageKey;
  if (typeof post.imageUrl === 'string' && post.imageUrl.startsWith('/img/facebook/')) return post.imageUrl.slice('/img/'.length);
  return null;
}
function emptyFeed() {
  return { updatedAt: new Date().toISOString(), posts: [] };
}
async function saveImage(post, env, previousPost) {
  if (!post.full_picture) return { imageKey: null, imageUrl: null };
  const sourceVersion = imageSourceVersion(post);
  if (!shouldRefreshImage(post, previousPost)) {
    const key = imageKeyFromPost(previousPost);
    return { imageKey: key, imageUrl: `/img/${key}`, imageSourceVersion: sourceVersion };
  }
  try {
    const response = await fetch(post.full_picture);
    if (!response.ok) throw new Error(`Facebook image returned ${response.status}`);
    const format = imageFormat(response.headers.get('content-type'));
    const key = imageKey(post.id, await versionToken(sourceVersion), format.extension);
    await env.PHOTOS.put(key, response.body, { httpMetadata: { contentType: format.contentType } });
    return { imageKey: key, imageUrl: `/img/${key}`, imageSourceVersion: sourceVersion };
  } catch (error) {
    const previousKey = imageKeyFromPost(previousPost ?? {});
    console.error('Unable to store Facebook post image', { postId: post.id, error: String(error) });
    return previousKey
      ? { imageKey: previousKey, imageUrl: `/img/${previousKey}`, imageSourceVersion: previousPost?.imageSourceVersion }
      : { imageKey: null, imageUrl: null, imageSourceVersion: sourceVersion };
  }
}

function safePostId(postId) {
  return String(postId).replace(/[^A-Za-z0-9_-]/g, '_');
}

function belongsToLivePost(key, livePostIds) {
  return Array.from(livePostIds).some((postId) => {
    const base = `facebook/${safePostId(postId)}`;
    return key.startsWith(`${base}-`) || key.startsWith(`${base}.`);
  });
}

async function pruneFeedImages(env, protectedPosts, now) {
  const livePostIds = new Set(protectedPosts.map((post) => post.id));
  const protectedKeys = new Set(protectedPosts.map(imageKeyFromPost).filter(Boolean));
  let cursor;
  do {
    const page = await env.PHOTOS.list({ prefix: 'facebook/', cursor });
    // Keep every version for posts still in the feed. This preserves local
    // cache compatibility when a post image refreshes to a new versioned key.
    const staleKeys = page.objects.filter((object) =>
      !protectedKeys.has(object.key) && !belongsToLivePost(object.key, livePostIds) &&
      // Also protect recent uploads that are not yet visible in a KV reader.
      new Date(object.uploaded).getTime() <= now - IMAGE_RETENTION_MS,
    ).map((object) => object.key);
    await Promise.all(staleKeys.map((key) => env.PHOTOS.delete(key)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
async function getCurrentFeed(env) {
  return (await env.FB_KV.get(FEED_KEY, 'json')) ?? emptyFeed();
}
function publicFeed(feed, now = new Date()) {
  const updatedAt = Date.parse(feed.updatedAt);
  const isStale =
    !Number.isFinite(updatedAt) ||
    now.getTime() - updatedAt > 4 * 24 * 60 * 60 * 1000;

  if (isStale) {
    return {
      updatedAt: feed.updatedAt,
      posts: [],
    };
  }

  return {
    updatedAt: feed.updatedAt,
    posts: (feed.posts ?? []).map(({ imageKey: _imageKey, imageSourceVersion: _imageSourceVersion, ...post }) => ({
      ...post,
      postedLabel: postedLabel(post.createdTime, now),
    })),
  };
}

async function refreshFeed(env) {
  const previous = await getCurrentFeed(env);
  const previousById = new Map((previous.posts ?? []).map((post) => [post.id, post]));
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${env.FB_PAGE_ID}/posts`);
  url.search = new URLSearchParams({ fields: 'id,message,created_time,updated_time,permalink_url,full_picture', limit: String(MAX_POSTS) }).toString();
  let response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${env.FB_SYSTEM_TOKEN}` } });
  } catch (error) {
    console.error('Facebook Graph API request failed', String(error));
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);

    console.error('Facebook Graph API returned an error', {
      status: response.status,
      code: body?.error?.code,
      subcode: body?.error?.error_subcode,
      message: body?.error?.message,
    });

    return;
  }
  let result;
  try {
    result = await response.json();
    if (!Array.isArray(result?.data)) throw new Error('Invalid Facebook feed shape');
  } catch {
    console.error('Facebook Graph API returned an invalid feed');
    return;
  }
  const latestPosts = (result.data ?? [])
    .map((post) => ({ ...post, message: cleanMessage(post.message) }))
    .filter((post) => post.id && post.created_time && post.permalink_url && (post.message || post.full_picture))
    .sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time))
    .slice(0, MAX_POSTS);
  const posts = await Promise.all(latestPosts.map(async (post) => ({
    id: post.id,
    message: post.message,
    createdTime: post.created_time,
    permalinkUrl: post.permalink_url,
    ...(await saveImage(post, env, previousById.get(post.id))),
  })));
  const now = Date.now();
  const liveIds = new Set(posts.map((post) => post.id));
  const liveKeys = new Set(posts.map(imageKeyFromPost).filter(Boolean));
  const retainedPosts = (previous.retainedPosts ?? []).filter((post) =>
    post.retainUntil > now && !liveKeys.has(post.imageKey),
  );
  for (const post of previous.posts ?? []) {
    const key = imageKeyFromPost(post);
    // An old exact key may use a legacy dated path even when its post remains
    // live. Preserve it too when the image changes or disappears from Graph.
    if (!liveIds.has(post.id) || (key && !liveKeys.has(key))) {
      retainedPosts.push({ id: post.id, imageKey: key, retainUntil: now + IMAGE_RETENTION_MS });
    }
  }
  // Commit the feed and retention information together. If publication fails,
  // leave every old image intact; a later cron can try publication again.
  try {
    await env.FB_KV.put(FEED_KEY, JSON.stringify({ updatedAt: new Date(now).toISOString(), posts, retainedPosts }));
  } catch {
    console.error('Unable to publish Facebook feed');
    return;
  }
  try {
    // Scan on every successful refresh, even if posts are unchanged. Failed
    // deletes remain eligible on the next refresh without another post change.
    await pruneFeedImages(env, [...posts, ...retainedPosts], now);
  } catch {
    console.error('Unable to prune stale Facebook feed images; will retry after the next successful refresh');
  }
}

// ── Specials import pipeline ──────────────────────────────────────────────────


const IMPORT_HOUR_START = 7;   // 7 AM Chicago, inclusive
const IMPORT_HOUR_END = 20;    // 8 PM Chicago, exclusive
const IMPORT_IMAGE_RETENTION_DAYS = 30;
const SPECIALS_AI_MODEL_DEFAULT = '@cf/google/gemma-4-26b-a4b-it';

function chicagoHour(now) {
  const parts = hourFormatter.formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  return h === 24 ? 0 : h; // some Intl impls return 24 for midnight
}

function isWithinProcessingHours(now) {
  const h = chicagoHour(now);
  return h >= IMPORT_HOUR_START && h < IMPORT_HOUR_END;
}

async function hexDigest(text, byteCount) {
  const encoded = new TextEncoder().encode(String(text ?? ''));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .slice(0, byteCount)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function importSourceId(postId, captionDigest, imageSrcVer, parserVersion, modelId) {
  return hexDigest(`${postId}:${captionDigest}:${imageSrcVer}:${parserVersion}:${modelId}`, 16);
}

// Resolve each local midnight independently: DST days can be 23 or 25 hours.
export function chicagoDayWindow(now) {
  const formatter = new Intl.DateTimeFormat('en-US', {timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const midnight = iso => {
    const target = Date.parse(`${iso}T00:00:00Z`);
    let guess = target;
    for (let i=0;i<3;i++) {
      const p = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(x=>[x.type,x.value]));
      const observed = Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second));
      guess += target-observed;
    }
    return guess/1000;
  };
  const today = chicagoDate(now);
  return {today,weekday:new Date(`${today}T12:00:00Z`).getUTCDay(),since:midnight(today),until:midnight(chicagoCalendarOffset(now,1))};
}

async function fetchScanPosts(env, now, window) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${env.FB_PAGE_ID}/posts`);
  url.search = new URLSearchParams({
    fields: 'id,message,created_time,updated_time,permalink_url,full_picture',
    since: String(window.since), until: String(window.until), limit: '100',
  }).toString();
  const posts = new Map(), cursors = new Set();
  try {
    // Page only within today's bounds; never fall back to a recent-post scan.
    for (let page=0;page<10;page++) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${env.FB_SYSTEM_TOKEN}` } });
      if (!response.ok) return [];
      const result = await response.json();
      if (!Array.isArray(result?.data)) return [];
      for (const post of result.data) {
        const created = Date.parse(post.created_time);
        if (post.id && Number.isFinite(created) && created >= window.since*1000 && created < window.until*1000 && created <= now.getTime()) posts.set(post.id,post);
      }
      if (!result.paging?.next) return [...posts.values()].sort((a,b)=>Date.parse(a.updated_time || a.created_time)-Date.parse(b.updated_time || b.created_time));
      const after = result.paging?.cursors?.after;
      if (typeof after !== 'string' || !after || cursors.has(after)) return [];
      cursors.add(after);
      url.searchParams.set('after',after);
    }
  } catch { /* Failed or incomplete retrieval must not publish a partial scan. */ }
  return [];
}

async function storeImportImage(env, post, imageSrcVer, attemptToken) {
  if (!post.full_picture) return { imageR2Key: null, imageHash: null };
  try {
    const response = await fetch(post.full_picture);
    if (!response.ok) return {imageR2Key:null,imageHash:null,
      transient:isTransientFailure({status:response.status}),reason:`Image HTTP ${response.status}`};
    const format = imageFormat(response.headers.get('content-type'));
    const bytes = await response.arrayBuffer();
    const data = new Uint8Array(bytes);
    const starts = signature => signature.every((byte,i)=>data[i]===byte);
    const valid = format.contentType === 'image/jpeg' ? starts([255,216,255]) :
      format.contentType === 'image/png' ? starts([137,80,78,71,13,10,26,10]) :
      format.contentType === 'image/gif' ? /^GIF8[79]a/.test(new TextDecoder().decode(data.slice(0,6))) :
      format.contentType === 'image/webp' ? starts([82,73,70,70]) && new TextDecoder().decode(data.slice(8,12)) === 'WEBP' : false;
    if (!valid || bytes.byteLength > 10*1024*1024) return {imageR2Key:null,imageHash:null,reason:'invalid or oversized image'};
    const imgDigest = await crypto.subtle.digest('SHA-256', bytes);
    const imageHash = Array.from(new Uint8Array(imgDigest))
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    // Attempt-specific keys fence delayed R2 writes as well as D1 pointers.
    const key = `special-imports/${safePostId(post.id)}-${await versionToken(imageSrcVer)}-${attemptToken}.${format.extension}`;
    await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: format.contentType } });
    return { imageR2Key: key, imageHash };
  } catch (error) {
    return {imageR2Key:null,imageHash:null,transient:isTransientFailure(error),reason:safeAiError(error,env)};
  }
}

async function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return btoa(binary);
}

// Each extract event reserves one actual provider invocation, including failures/retries.
// A crash between reservation and invocation conservatively consumes that reservation.
const AI_COUNT_SQL = `(SELECT count(*) FROM special_import_events WHERE event_type='extract'
  AND julianday(occurred_at)>=julianday(?1) AND julianday(occurred_at)<julianday(?2))
  + (SELECT count(*) FROM special_imports i WHERE julianday(i.processed_at)>=julianday(?1)
    AND julianday(i.processed_at)<julianday(?2)
    AND NOT EXISTS(SELECT 1 FROM special_import_events e WHERE e.import_id=i.id AND e.event_type='extract'))`;

async function runAiExtraction(env, imageR2Key, caption, modelId, budget) {
  const r2Object = await env.PHOTOS.get(imageR2Key);
  if (!r2Object) return {extractedJson:null,imageMissing:true};
  const image = `data:${r2Object.httpMetadata?.contentType ?? 'image/jpeg'};base64,${await arrayBufferToBase64(await r2Object.arrayBuffer())}`;
  let outcome = {extractedJson:null};
  let lastValidationReason = null;
  // Tracks whether a Tuesday empty-offers result has armed the Mexican Night targeted retry.
  let needsMexicanNightRetry = false;
  for (let attempt=0;attempt<2;attempt++) {
    const now = new Date(Date.now());
    if (!isWithinProcessingHours(now) || chicagoDate(now)!==budget.window.today) return outcome;
    const reservation = await env.DB.prepare(`INSERT INTO special_import_events(import_id,event_type,detail,occurred_at)
      SELECT ?3,'extract',?4,?5 WHERE (${AI_COUNT_SQL})<?6
      AND EXISTS(SELECT 1 FROM special_imports i WHERE i.id=?3 AND i.attempt_token=?7
        AND i.processing_status='processing' AND i.review_status='pending' AND julianday(i.lease_expires_at)>julianday(?5)
        AND NOT EXISTS(SELECT 1 FROM special_imports newer WHERE newer.fb_post_id=i.fb_post_id
          AND newer.parser_version=i.parser_version AND newer.rowid>i.rowid))`).bind(
      new Date(budget.window.since*1000).toISOString(),new Date(budget.window.until*1000).toISOString(),
      budget.importId,modelId,now.toISOString(),budget.dailyLimit,budget.record.attempt_token).run();
    if (reservation.meta?.changes!==1) return attempt ? outcome : {extractedJson:null,budgetExceeded:true};
    if (attempt) {
      // Select the most informative retry description and the focused schema.
      const retryDetail = lastValidationReason === WEEKLY_LUNCH_SHAPE_ERROR
        ? 'Weekly-lunch-specific retry: forcing weekly-lunch shape and schema'
        : (needsMexicanNightRetry || lastValidationReason === MEXICAN_NIGHT_SHAPE_ERROR)
          ? 'Mexican Night targeted retry: determining from image whether poster is Mexican Night'
          : lastValidationReason === WEEKDAY_ENCODING_MISMATCH
            ? `Weekday encoding mismatch retry: ${WEEKDAY_ENCODING_MISMATCH}`
            : 'One retry with identical extraction instructions and schema';
      await attemptEvent(env,budget.record,'retry',retryDetail);
    }
    const request = lastValidationReason === WEEKLY_LUNCH_SHAPE_ERROR
      ? buildWeeklyLunchExtractionRequest(caption,image)
      : (needsMexicanNightRetry || lastValidationReason === MEXICAN_NIGHT_SHAPE_ERROR)
        ? buildMexicanNightExtractionRequest(caption,image)
        : buildExtractionRequest(caption,image);
    // A reservation may outlive a review change or lease while waiting on D1.
    // Keep it charged conservatively, but do not invoke AI without ownership.
    const callNow=new Date(Date.now());
    if (!isWithinProcessingHours(callNow) || chicagoDate(callNow)!==budget.window.today ||
      !await env.DB.prepare(`SELECT 1 WHERE ${OWNS_ATTEMPT_SQL}`)
        .bind(budget.importId,budget.record.attempt_token,callNow.toISOString()).first()) return {cancelled:true};
    try {
      const result = await env.AI.run(modelId,request);
      const raw = result?.choices?.[0]?.message?.content ?? result?.response;
      outcome = {extractedJson:typeof raw==='string' ? raw : JSON.stringify(raw ?? null),processedAt:now.toISOString()};
    } catch(error) {
      const aiError = safeAiError(error,env);
      outcome = {extractedJson:null,aiError,transient:isTransientFailure(error),processedAt:now.toISOString()};
      if (!/json[ _]mode|json[ _]schema/i.test(aiError)) return outcome;
      continue;
    }
    const validation = validateExtraction(outcome.extractedJson);
    lastValidationReason = validation.validationReason;
    // Tuesday empty-offers: generic validation passed but offers are empty → retry once
    // with the targeted Mexican Night extraction to check whether the image is Mexican Night.
    // Only fires on attempt 0; never infers Mexican Night from Tuesday or time alone.
    if (attempt === 0 && budget.window.weekday === 2 && validation.validationReason === 'poster evidence') {
      try {
        const parsedOffers = JSON.parse(outcome.extractedJson)?.offers;
        if (Array.isArray(parsedOffers) && parsedOffers.length === 0) needsMexicanNightRetry = true;
      } catch { /* ignore; leave needsMexicanNightRetry false */ }
    }
    // Tuesday misread: a weekly-lunch response that fails weekly-lunch validation
    // gets the same targeted check. A real Mexican Night heading is still required.
    if (attempt === 0 && budget.window.weekday === 2 && validation.validationResult === 'rejected') {
      try {
        if (JSON.parse(outcome.extractedJson.replace(/^```(?:json)?\n?|\n?```$/gm, '').trim())?.type === 'weekly-lunch') needsMexicanNightRetry = true;
      } catch { /* ignore; leave needsMexicanNightRetry false */ }
    }
    // Retry unusable response shapes or inconsistent weekday encoding once; never coerce a day.
    if (!needsMexicanNightRetry && !['response is not valid JSON','no AI response',WEEKLY_LUNCH_SHAPE_ERROR,MEXICAN_NIGHT_SHAPE_ERROR,WEEKDAY_ENCODING_MISMATCH].includes(validation.validationReason)) return outcome;
  }
  return outcome;
}

// Keep actionable provider errors without persisting credentials or echoed images.
function safeAiError(error, env) {
  let message = String(error);
  for (const [key, value] of Object.entries(env)) {
    if (/token|secret|password|api.?key/i.test(key) && typeof value === 'string' && value) {
      message = message.split(value).join('[redacted]');
    }
  }
  return message
    .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/((?:access_token|api_key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, '$1[redacted]')
    .replace(/data:image\/[^;\s]+;base64,[a-z0-9+/=]+/gi, '[image redacted]')
    .slice(0, 1000);
}

const VALID_SERVICES = new Set(['lunch', 'nightly', 'all-day', 'custom']);

function validateExtraction(extractedJson) {
  if (!extractedJson) {
    return { candidateJson: null, validationResult: 'rejected', validationReason: 'no AI response' };
  }
  let parsed;
  try {
    parsed = JSON.parse(extractedJson.replace(/^```(?:json)?\n?|\n?```$/gm, '').trim());
  } catch {
    return { candidateJson: null, validationResult: 'rejected', validationReason: 'response is not valid JSON' };
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.type === 'weekly-lunch') {
    try {
      const daily=singleDayLunchEvidence(parsed);
      return {candidateJson:JSON.stringify(daily ?? validateWeeklyLunch(parsed)),validationResult:'ok',validationReason:daily ? 'single-day lunch evidence' : 'weekly lunch evidence'};
    }
    catch (error) { return {candidateJson:null,validationResult:'rejected',validationReason:error.message}; }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.type === 'mexican-night') {
    try { return {candidateJson:JSON.stringify(validateMexicanNight(parsed)),validationResult:'ok',validationReason:'mexican night evidence'}; }
    catch (error) { return {candidateJson:null,validationResult:'rejected',validationReason:error.message}; }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'offers' in parsed) {
    try { return {candidateJson:JSON.stringify(validateEvidence(parsed)),validationResult:'ok',validationReason:'poster evidence'}; }
    catch (error) { return {candidateJson:null,validationResult:'rejected',validationReason:error.message}; }
  }
  // Historical group-shaped responses remain reviewable, never auto-published.
  if (!Array.isArray(parsed) || parsed.length > 84) {
    return { candidateJson: null, validationResult: 'rejected', validationReason: 'expected a JSON array' };
  }
  const groups = [];
  const groupKeys = new Set();
  for (const g of parsed) {
    if (!g || typeof g.label !== 'string') {
      return { candidateJson: null, validationResult: 'rejected', validationReason: 'group missing string label' };
    }
    if (!Number.isInteger(g.day_of_week) || g.day_of_week < -1 || g.day_of_week > 6) {
      return { candidateJson: null, validationResult: 'rejected', validationReason: 'invalid day_of_week' };
    }
    if (!VALID_SERVICES.has(g.service)) {
      return { candidateJson: null, validationResult: 'rejected', validationReason: `invalid service: ${g.service}` };
    }
    if (!Array.isArray(g.items)) {
      return { candidateJson: null, validationResult: 'rejected', validationReason: 'group missing items array' };
    }
    const groupKey = `${g.day_of_week}:${g.service}`;
    if (g.service !== 'custom' && groupKeys.has(groupKey)) return {candidateJson:null,validationResult:'rejected',validationReason:'duplicate day/service group'};
    groupKeys.add(groupKey);
    const items = [];
    for (const item of g.items) {
      if (!item || typeof item.content !== 'string' || (item.price != null && typeof item.price !== 'string')) {
        return { candidateJson: null, validationResult: 'rejected', validationReason: 'item missing string content' };
      }
      const content = [item.content, item.price ?? ''].filter(Boolean).join(' ');
      if (!item.content.trim() || content.length > 150) {
        return { candidateJson: null, validationResult: 'rejected', validationReason: 'item content exceeds 150 characters' };
      }
      items.push({ content });
    }
    groups.push({ label: g.label.slice(0, 80), day_of_week: g.day_of_week, service: g.service, items });
  }
  const offerKey = text => text.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const g of groups) {
    if ([1,5].includes(g.day_of_week) && ['lunch','nightly'].includes(g.service)) {
      g.items = g.items.filter(item => !groups.some(other => other.day_of_week === g.day_of_week && other.service === 'all-day' && other.items.some(allDay => offerKey(allDay.content) === offerKey(item.content))));
    }
    const capacity = g.service === 'lunch' ? 1 : g.service === 'all-day' ? 2 : g.service === 'nightly' ? ([0,6].includes(g.day_of_week) ? 0 : [1,5].includes(g.day_of_week) ? 2 : 1) : g.day_of_week === -1 ? 4 : 1;
    if (g.items.length > capacity) return { candidateJson: null, validationResult: 'rejected', validationReason: 'too many items for service; review All Day grouping' };
  }
  return {
    candidateJson: JSON.stringify(groups),
    validationResult: 'ok',
    validationReason: `${groups.length} group(s)`,
  };
}

async function pruneImportImages(env) {
  const cutoff = Date.now() - IMPORT_IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let cursor;
  do {
    const page = await env.PHOTOS.list({ prefix: 'special-imports/', cursor });
    await Promise.all(
      page.objects
        .filter((obj) => new Date(obj.uploaded).getTime() < cutoff)
        .map((obj) => env.PHOTOS.delete(obj.key)),
    );
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function processImportAttempt(env, record, raw, {window,modelId,dailyLimit}) {
  const retry = async (reason,kind,extra={}) => finishImportAttempt(env,record,{
    ...extra,status:record.retry_count<MAX_IMPORT_ATTEMPTS ? 'pending' : 'failed',
    failureKind:record.retry_count<MAX_IMPORT_ATTEMPTS ? kind : 'exhausted',reason,lastError:reason,
  });
  try {
    if (!record.image_r2_key) {
      const image = await storeImportImage(env,raw,record.image_source_version,record.attempt_token);
      if (!image.imageR2Key) {
        if (image.transient) return await retry(image.reason,'transient_image');
        return await finishImportAttempt(env,record,{status:'skipped',failureKind:'permanent',reason:image.reason ?? 'no image'});
      }
      if (!await saveAttemptImage(env,record,image)) return;
      record.image_r2_key=image.imageR2Key;
      record.image_hash=image.imageHash;
    }
    const result = await runAiExtraction(env,record.image_r2_key,record.caption,modelId,
      {importId:record.id,record,window,dailyLimit});
    if (result.cancelled) return; // Lease/cutoff guards or next cron handle unfinished work.
    if (result.imageMissing) return await retry('Stored image unavailable','transient_image',{clearImage:true});
    if (result.budgetExceeded) return await finishImportAttempt(env,record,{
      status:'skipped',failureKind:'budget',reason:'daily AI limit reached',
    });
    if (result.aiError) {
      const reason=`Workers AI extraction failed: ${result.aiError}`;
      console.error('Import pipeline: Workers AI extraction failed',{importId:record.id,modelId,error:result.aiError});
      if (result.transient) return await retry(reason,'transient_ai',{processedAt:result.processedAt});
      return await finishImportAttempt(env,record,{
        status:'failed',failureKind:'permanent',reason,lastError:reason,
        validationResult:'rejected',processedAt:result.processedAt,
      });
    }
    const validation=validateExtraction(result.extractedJson);
    await finishImportAttempt(env,record,{
      status:validation.validationResult==='ok' ? 'staged' : 'failed',
      failureKind:validation.validationResult==='ok' ? null : 'permanent',
      reason:validation.validationReason,validationResult:validation.validationResult,
      candidateJson:validation.candidateJson,extractedJson:result.extractedJson,processedAt:result.processedAt,
    });
  } catch (error) {
    // Infrastructure failure only: validation produces explicit permanent outcomes.
    // If D1 is unavailable too, keep the lease; cron can reclaim it after expiry.
    const reason=safeAiError(error,env);
    console.error('Import pipeline: attempt storage error',{importId:record.id,error:reason});
    try { await retry(reason,'transient_storage'); } catch { /* Durable lease remains. */ }
  }
}

export async function runImportPipeline(env) {
  const mode = env.SPECIALS_IMPORT_MODE ?? 'OFF';
  if (!['DRY_RUN','GUARDED_AUTO'].includes(mode) || !env.DB) return;
  const now = new Date(Date.now());
  const window = chicagoDayWindow(now);
  const modelId = env.SPECIALS_AI_MODEL ?? SPECIALS_AI_MODEL_DEFAULT;
  const dailyLimit = Number(env.SPECIALS_AI_DAILY_LIMIT ?? 50);
  // Retire work without inference, including after closing or on the following day.
  await retireImportAttempts(env,{window,modelId,parserVersion:PARSER_VERSION,closed:chicagoHour(now)>=IMPORT_HOUR_END});
  // Sunday provisioning retains its separate evening lifecycle.
  if (mode === 'GUARDED_AUTO' && window.weekday===0 && chicagoHour(now)>=19) {
    await ensureAutomaticWeek(env,{...window,hour:chicagoHour(now)});
  }
  if (!isWithinProcessingHours(now)) return;
  if (mode === 'GUARDED_AUTO' && !(window.weekday===0 && chicagoHour(now)>=19)) await ensureAutomaticWeek(env,{...window,hour:chicagoHour(now)});
  const sourceIds=[], work=[];
  const rawPosts = await fetchScanPosts(env, now, window);
  // Register the COMPLETE scan before processing, so recovery never publishes a
  // single new poster while another known current source is still pending.
  for (const raw of rawPosts) {
    const caption = cleanMessage(raw.message ?? '');
    const classification = classifyCaption(caption);
    if (classification.kind === 'ignored' && !raw.full_picture) continue;
    const captionDigest = await hexDigest(caption, 8);
    const imgSrcVer = imageSourceVersion(raw);
    const importId = await importSourceId(`${env.FB_PAGE_ID}:${raw.id}`, captionDigest, imgSrcVer, PARSER_VERSION, modelId);
    sourceIds.push(importId);
    await env.DB.prepare(`INSERT OR IGNORE INTO special_imports(
      id,fb_post_id,fb_created_time,fb_updated_time,caption,permalink_url,
      caption_hash,image_source_version,parser_version,model_id,
      target_kind,target_day,target_service,target_collection_id,classification_reason,processing_status,fetched_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'pending',?16)`).bind(
      importId,raw.id,raw.created_time,raw.updated_time ?? null,caption,raw.permalink_url ?? '',
      captionDigest,imgSrcVer,PARSER_VERSION,modelId,classification.kind,classification.day,
      classification.service,classification.collectionId,classification.reason,new Date(Date.now()).toISOString()).run();
    work.push({importId,raw});
  }
  for (const {importId,raw} of work) {
    const processingNow = new Date(Date.now());
    if (!isWithinProcessingHours(processingNow) || chicagoDate(processingNow) !== window.today) break;
    // A fresh matching Graph source supplies current image URLs. No retry of a
    // removed/edited source, incomplete Graph scan, or yesterday's pending row.
    const record=await claimImportAttempt(env,importId,{window,modelId,parserVersion:PARSER_VERSION,mode});
    if (record) await processImportAttempt(env,record,raw,{window,modelId,dailyLimit});
  }
  // Reuse durable evidence even when every source claim was already present.
  // A complete today-only Graph scan supplies the current versions for this Page.
  const writeNow=new Date(Date.now());
  if (mode==='GUARDED_AUTO' && isWithinProcessingHours(writeNow) && chicagoDate(writeNow)===window.today) {
    await reconcileToday(env,{sourceIds,today:window.today,weekday:window.weekday});
    try { await reconcileWeeklyLunch(env,window.today); }
    catch(err) { console.error('Weekly lunch reconcile error',String(err)); }
    try { await reconcileMexicanNight(env); }
    catch(err) { console.error('Mexican Night reconcile error',String(err)); }
  }
  try { await pruneImportImages(env); }
  catch { console.error('Import pipeline: unable to prune old import images'); }
  try { await pruneImportHistory(env,now); }
  catch { console.error('Import pipeline: unable to prune old import history'); }
}

export async function requeueFailedImport(env, importId) {
  const record = await env.DB.prepare('SELECT id, processing_status FROM special_imports WHERE id=?1').bind(importId).first();
  if (!record) throw new Error(`Import not found: ${importId}`);
  if (record.processing_status !== 'failed') throw new Error(`Import is not in failed state: ${record.processing_status}`);
  const token=crypto.randomUUID();
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE special_imports SET processing_status='pending',extracted_json=NULL,candidate_json=NULL,
      validation_result=NULL,validation_reason='',processed_at=NULL,last_error=NULL,failure_kind=NULL,
      retry_count=0,attempt_token=?2,lease_expires_at=NULL,next_attempt_at=NULL
      WHERE id=?1 AND processing_status='failed' AND review_status='pending'`).bind(importId,token),
    env.DB.prepare(`INSERT INTO special_import_events(import_id,event_type,detail)
      SELECT ?1,'requeue','manually requeued for reprocessing' WHERE EXISTS(
        SELECT 1 FROM special_imports WHERE id=?1 AND attempt_token=?2 AND processing_status='pending')`).bind(importId,token),
  ]);
  if (result[0].meta?.changes !== 1) throw new Error('Failed to requeue import');
  return {requeued: true, id: importId};
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(refreshFeed(env));
    ctx.waitUntil(runImportPipeline(env).catch((err) => console.error('Import pipeline fatal error', String(err))));
  },
  // Webhook triggers run the same complete-day work as the cron, once per batch:
  // redundant deliveries in a burst collapse, and repeats are idempotent claims.
  // A pipeline error is rethrown so Queues retries the batch, then dead-letters it.
  async queue(batch, env) {
    console.log('Facebook webhook trigger batch', {messages: batch.messages.length});
    const [, imports] = await Promise.allSettled([refreshFeed(env), runImportPipeline(env)]);
    if (imports.status === 'rejected') {
      console.error('Import pipeline fatal error (webhook trigger)', String(imports.reason));
      throw imports.reason;
    }
  },
 async fetch(request, env, ctx) {
  if (new URL(request.url).pathname === WEBHOOK_PATH) return handleFacebookWebhook(request, env);
  if (request.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: {
        ...RESPONSE_SECURITY_HEADERS,
        Allow: 'GET',
      },
    });
  }

  // The Chicago date in the cache key refreshes relative date labels at local midnight.
  const url = new URL(request.url);
  const cacheKey = new Request(
    `${url.origin}${url.pathname}?date=${chicagoDate()}`,
  );

  const cache = caches.default;
  const cached = await cache.match(cacheKey);

  if (cached) return cached;

  // This handler only reads FB_KV. Graph API calls and KV writes are limited
  // to refreshFeed(), which is called only by the cron and webhook queue handlers.
  const response = Response.json(
    publicFeed(await getCurrentFeed(env)),
    {
      headers: {
        ...RESPONSE_SECURITY_HEADERS,
        'Cache-Control': 'public, max-age=60',
      },
    },
  );

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
},
};
