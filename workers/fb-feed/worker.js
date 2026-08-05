const TIME_ZONE = 'America/Chicago';
const GRAPH_API_VERSION = 'v26.0';
const FEED_KEY = 'fb:feed';
const MAX_POSTS = 4;

const RESPONSE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};

const datePartsFormatter = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const displayDateFormatter = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric' });

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
function postSetChanged(previousPosts, posts) {
  return previousPosts.map((post) => post.id).join('|') !== posts.map((post) => post.id).join('|');
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

async function pruneFeedImages(env, livePostIds) {
  let cursor;
  do {
    const page = await env.PHOTOS.list({ prefix: 'facebook/', cursor });
    // Keep every version for posts still in the feed. This preserves local
    // cache compatibility when a post image refreshes to a new versioned key.
    const staleKeys = page.objects.map((object) => object.key).filter((key) => !belongsToLivePost(key, livePostIds));
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
  const result = await response.json();
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
  if (postSetChanged(previous.posts ?? [], posts)) {
    try {
      await pruneFeedImages(env, new Set(posts.map((post) => post.id)));
    } catch (error) {
      // A later scheduled refresh retries cleanup; a failed prune never blocks the feed.
      console.error('Unable to prune stale Facebook feed images', String(error));
    }
  }
  await env.FB_KV.put(FEED_KEY, JSON.stringify({ updatedAt: new Date().toISOString(), posts }));
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(refreshFeed(env));
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
