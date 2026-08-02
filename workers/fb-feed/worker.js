const TIME_ZONE = 'America/Chicago';
const GRAPH_API_VERSION = 'v26.0';
const FEED_KEY = 'fb:feed';
const MAX_POSTS = 4;

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
function imageKey(postId) {
  return `facebook/${postId.replace(/[^A-Za-z0-9_-]/g, '_')}.jpg`;
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
function needsImageKeyMigration(posts) {
  return posts.some((post) => {
    const key = imageKeyFromPost(post);
    return key && key !== imageKey(post.id);
  });
}

async function saveImage(post, env, previousPost) {
  if (!post.full_picture) return { imageKey: null, imageUrl: null };
  const key = imageKey(post.id);
  if (imageKeyFromPost(previousPost ?? {}) === key) return { imageKey: key, imageUrl: `/img/${key}` };
  try {
    const response = await fetch(post.full_picture);
    if (!response.ok) throw new Error(`Facebook image returned ${response.status}`);
    await env.PHOTOS.put(key, response.body, { httpMetadata: { contentType: response.headers.get('content-type') || 'image/jpeg' } });
    return { imageKey: key, imageUrl: `/img/${key}` };
  } catch (error) {
    const previousKey = imageKeyFromPost(previousPost ?? {});
    console.error('Unable to store Facebook post image', { postId: post.id, error: String(error) });
    return previousKey ? { imageKey: previousKey, imageUrl: `/img/${previousKey}` } : { imageKey: key, imageUrl: null };
  }
}

async function pruneFeedImages(env, liveKeys) {
  let cursor;
  do {
    const page = await env.PHOTOS.list({ prefix: 'facebook/', cursor });
    const staleKeys = page.objects.map((object) => object.key).filter((key) => !liveKeys.has(key));
    await Promise.all(staleKeys.map((key) => env.PHOTOS.delete(key)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
async function getCurrentFeed(env) {
  return (await env.FB_KV.get(FEED_KEY, 'json')) ?? emptyFeed();
}
function publicFeed(feed, now = new Date()) {
  return {
    updatedAt: feed.updatedAt,
    posts: (feed.posts ?? []).map(({ imageKey: _imageKey, ...post }) => ({ ...post, postedLabel: postedLabel(post.createdTime, now) })),
  };
}

async function refreshFeed(env) {
  const previous = await getCurrentFeed(env);
  const previousById = new Map((previous.posts ?? []).map((post) => [post.id, post]));
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${env.FB_PAGE_ID}/posts`);
  url.search = new URLSearchParams({ fields: 'id,message,created_time,permalink_url,full_picture', limit: String(MAX_POSTS) }).toString();
  let response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${env.FB_SYSTEM_TOKEN}` } });
  } catch (error) {
    console.error('Facebook Graph API request failed', String(error));
    return;
  }
  if (!response.ok) {
    console.error('Facebook Graph API returned an error', response.status);
    return;
  }
  const result = await response.json();
  const latestPosts = (result.data ?? []).filter((post) => post.id && post.created_time && post.permalink_url).sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time)).slice(0, MAX_POSTS);
  const posts = await Promise.all(latestPosts.map(async (post) => ({
    id: post.id,
    message: typeof post.message === 'string' ? post.message : '',
    createdTime: post.created_time,
    permalinkUrl: post.permalink_url,
    ...(await saveImage(post, env, previousById.get(post.id))),
  })));
  if (postSetChanged(previous.posts ?? [], posts) || needsImageKeyMigration(previous.posts ?? [])) {
    try {
      await pruneFeedImages(env, new Set(posts.map((post) => post.imageKey).filter(Boolean)));
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
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    // The Chicago date in the cache key refreshes relative date labels at local midnight.
    const url = new URL(request.url);
    const cacheKey = new Request(`${url.origin}${url.pathname}?date=${chicagoDate()}`);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    // This handler only reads FB_KV. Graph API calls and KV writes are limited
    // to refreshFeed(), which is called solely by the scheduled cron handler.
    const response = Response.json(publicFeed(await getCurrentFeed(env)), { headers: { 'Cache-Control': 'public, max-age=60' } });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
