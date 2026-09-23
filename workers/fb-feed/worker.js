import { classifyCaption, PARSER_VERSION } from './classify.js';

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

const IMPORT_SCAN_LIMIT = 20;
const IMPORT_HOUR_START = 7;   // 7 AM Chicago, inclusive
const IMPORT_HOUR_END = 20;    // 8 PM Chicago, exclusive
const IMPORT_IMAGE_RETENTION_DAYS = 30;
const SPECIALS_AI_MODEL_DEFAULT = '@cf/meta/llama-3.2-11b-vision-instruct';

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

async function fetchScanPosts(env) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${env.FB_PAGE_ID}/posts`);
  url.search = new URLSearchParams({
    fields: 'id,message,created_time,updated_time,permalink_url,full_picture',
    limit: String(IMPORT_SCAN_LIMIT),
  }).toString();
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${env.FB_SYSTEM_TOKEN}` } });
    if (!response.ok) return [];
    const result = await response.json();
    return Array.isArray(result?.data) ? result.data.filter((p) => p.id && p.created_time) : [];
  } catch {
    return [];
  }
}

async function storeImportImage(env, post, imageSrcVer) {
  if (!post.full_picture) return { imageR2Key: null, imageHash: null };
  try {
    const response = await fetch(post.full_picture);
    if (!response.ok) return { imageR2Key: null, imageHash: null };
    const format = imageFormat(response.headers.get('content-type'));
    const bytes = await response.arrayBuffer();
    const imgDigest = await crypto.subtle.digest('SHA-256', bytes);
    const imageHash = Array.from(new Uint8Array(imgDigest))
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const key = `special-imports/${safePostId(post.id)}-${await versionToken(imageSrcVer)}.${format.extension}`;
    await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: format.contentType } });
    return { imageR2Key: key, imageHash };
  } catch {
    return { imageR2Key: null, imageHash: null };
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

async function runAiExtraction(env, imageR2Key, caption, modelId) {
  const r2Object = await env.PHOTOS.get(imageR2Key);
  if (!r2Object) return { extractedJson: null };
  const contentType = r2Object.httpMetadata?.contentType ?? 'image/jpeg';
  const bytes = await r2Object.arrayBuffer();
  const base64 = await arrayBufferToBase64(bytes);
  const prompt = `Extract restaurant daily specials from this image. Return ONLY a JSON array:
[{"label":"<name>","day_of_week":<0-6 or -1>,"service":"<lunch|nightly|all-day|custom>","items":[{"content":"<complete special including inline price>"}]}]
Keep prices inside content, maximum 150 characters including prices. Lunch has 1 item; All Day has 2; Monday and Friday Nightly have 2; other weekday Nightly has 1. Weekend special groups have 1 item (All Day still has 2); no weekend Nightly.
Monday/Friday graphics repeat All Day offers alongside Lunch/Nightly. Put those offers ONLY in an all-day group, never duplicate them into lunch/nightly. Keep price variants for one dish together in one item. Do not invent or truncate offers; if the grouping is unclear return [].
Day: 0=Sun,1=Mon,...,6=Sat; -1=untied to a specific day. Return [] if no specials visible. Caption: ${caption.slice(0, 200)}`;
  try {
    const result = await env.AI.run(modelId, {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${contentType};base64,${base64}` } },
        ],
      }],
      max_tokens: 1024,
    });
    const raw = result?.response;
    return { extractedJson: typeof raw === 'string' ? raw : JSON.stringify(raw ?? null) };
  } catch (error) {
    return { extractedJson: null, aiError: String(error) };
  }
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
  if (!Array.isArray(parsed)) {
    return { candidateJson: null, validationResult: 'rejected', validationReason: 'expected a JSON array' };
  }
  const groups = [];
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
    const items = [];
    for (const item of g.items) {
      if (!item || typeof item.content !== 'string' || (item.price != null && typeof item.price !== 'string')) {
        return { candidateJson: null, validationResult: 'rejected', validationReason: 'item missing string content' };
      }
      const content = [item.content, item.price ?? ''].filter(Boolean).join(' ');
      if (content.length > 150) {
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

async function countTodayAiCalls(env, modelId, today) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT count(*) AS n FROM special_imports WHERE date(processed_at)=?1 AND model_id=?2"
    ).bind(today, modelId).all();
    return Number(results?.[0]?.n ?? 0);
  } catch {
    return 0;
  }
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

async function runImportPipeline(env) {
  const mode = env.SPECIALS_IMPORT_MODE ?? 'OFF';
  if (mode === 'OFF') return;
  if (!env.DB) return;

  const now = new Date(Date.now());
  if (!isWithinProcessingHours(now)) return;

  const modelId = env.SPECIALS_AI_MODEL ?? SPECIALS_AI_MODEL_DEFAULT;
  const dailyLimit = Number(env.SPECIALS_AI_DAILY_LIMIT ?? 50);
  const today = chicagoDate(now);

  let aiCallsToday = await countTodayAiCalls(env, modelId, today);

  const rawPosts = await fetchScanPosts(env);

  for (const raw of rawPosts) {
    try {
      const caption = cleanMessage(raw.message ?? '');
      const classification = classifyCaption(caption);
      if (classification.kind === 'ignored') continue;

      const captionDigest = await hexDigest(caption, 8);
      const imgSrcVer = imageSourceVersion(raw);
      const importId = await importSourceId(raw.id, captionDigest, imgSrcVer, PARSER_VERSION, modelId);

      const existing = await env.DB.prepare(
        'SELECT 1 FROM special_imports WHERE id=?1'
      ).bind(importId).first();
      if (existing) continue;

      const { imageR2Key, imageHash } = await storeImportImage(env, raw, imgSrcVer);

      let extractedJson = null;
      let candidateJson = null;
      let validationResult = null;
      let validationReason = '';
      let processedAt = null;
      let processingStatus = 'staged';

      if (imageR2Key && aiCallsToday < dailyLimit) {
        const aiResult = await runAiExtraction(env, imageR2Key, caption, modelId);
        extractedJson = aiResult.extractedJson;
        processedAt = new Date(Date.now()).toISOString();
        aiCallsToday++;
        const validation = validateExtraction(extractedJson);
        candidateJson = validation.candidateJson;
        validationResult = validation.validationResult;
        validationReason = validation.validationReason;
        if (validationResult === 'rejected') processingStatus = 'failed';
      } else if (!imageR2Key) {
        processingStatus = 'skipped';
        validationReason = 'no image';
      } else {
        processingStatus = 'skipped';
        validationReason = 'daily AI limit reached';
      }

      await env.DB.prepare(
        `INSERT OR IGNORE INTO special_imports(
          id,fb_post_id,fb_created_time,fb_updated_time,caption,permalink_url,
          caption_hash,image_source_version,image_r2_key,image_hash,
          parser_version,model_id,
          target_kind,target_day,target_service,target_collection_id,classification_reason,
          extracted_json,candidate_json,validation_result,validation_reason,
          processing_status,processed_at
        ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)`
      ).bind(
        importId, raw.id, raw.created_time, raw.updated_time ?? null,
        caption, raw.permalink_url ?? '',
        captionDigest, imgSrcVer, imageR2Key, imageHash,
        PARSER_VERSION, modelId,
        classification.kind, classification.day, classification.service,
        classification.collectionId, classification.reason,
        extractedJson, candidateJson, validationResult, validationReason,
        processingStatus, processedAt,
      ).run();

      const events = [
        { type: 'fetch', detail: `mode:${mode}` },
        ...(extractedJson !== null ? [{ type: 'extract', detail: modelId }] : []),
        ...(validationResult ? [{ type: 'validate', detail: validationReason }] : []),
      ];
      for (const ev of events) {
        await env.DB.prepare(
          'INSERT INTO special_import_events(import_id,event_type,detail) VALUES(?1,?2,?3)'
        ).bind(importId, ev.type, ev.detail).run();
      }
    } catch (error) {
      console.error('Import pipeline: error processing post', { postId: raw.id, error: String(error) });
    }
  }

  try {
    await pruneImportImages(env);
  } catch {
    console.error('Import pipeline: unable to prune old import images');
  }
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(refreshFeed(env));
    ctx.waitUntil(runImportPipeline(env).catch((err) => console.error('Import pipeline fatal error', String(err))));
  },
 async fetch(request, env, ctx) {
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
  // to refreshFeed(), which is called solely by the scheduled cron handler.
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
