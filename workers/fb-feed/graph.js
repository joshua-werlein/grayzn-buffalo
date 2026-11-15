// Shared Facebook Graph settings and a read-only post accessibility diagnostic.
// A GET can establish existence, but cannot establish deletion: 100/33 also
// covers missing permissions and unsupported operations, even after a valid scan.
export const GRAPH_API_VERSION = 'v26.0';

// 'exists' | 'unknown'. Neither feed absence nor repeated failures release a
// removal tombstone. No supported positive deletion signal is integrated here.
export async function graphPostStatus(env, postId, {timeoutMs = 5000} = {}) {
  if (typeof postId !== 'string' || !/^[\w-]{1,80}$/.test(postId) || !env?.FB_SYSTEM_TOKEN
    || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>5000) return 'unknown';
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${postId}`);
  url.search = new URLSearchParams({fields: 'id'}).toString();
  try {
    const response = await fetch(url, {headers: {Authorization: `Bearer ${env.FB_SYSTEM_TOKEN}`}, redirect:'error', signal: AbortSignal.timeout(timeoutMs)});
    const body = await response.json().catch(() => null);
    if (response.ok) return body?.id === postId ? 'exists' : 'unknown';
    return 'unknown';
  } catch { return 'unknown'; }
}

// When each source's poster was verifiably posted. A Facebook updated time alone
// proves nothing: comments can change it. It counts only for a version whose stored
// image or caption actually differs from the post's earlier version.
export async function verifiedPostTimes(env,sources) {
  if(!sources.length) return new Map();
  const posts=[...new Set(sources.map(s=>s.fb_post_id))];
  const {results:versions}=await env.DB.prepare(`SELECT id,fb_post_id,fb_created_time,fb_updated_time,image_hash,caption_hash
    FROM special_imports WHERE fb_post_id IN (SELECT value FROM json_each(?1)) ORDER BY rowid`).bind(JSON.stringify(posts)).all();
  const times=new Map(),state=new Map();
  const now=Date.now();
  for(const v of versions) {
    const prior=state.get(v.fb_post_id);
    const created=Date.parse(v.fb_created_time);
    const observed=Date.parse(v.fb_updated_time ?? v.fb_created_time);
    // Import insertion order can differ from Facebook revision order when scans
    // overlap. A delayed row cannot become the comparison baseline for a comment.
    if(!(created<=now) || (prior && observed<prior.observed)) {
      times.set(v.id,NaN);
      continue;
    }
    const changed=prior && v.image_hash && prior.image_hash && (v.image_hash!==prior.image_hash || v.caption_hash!==prior.caption_hash);
    const time=!prior?created:changed?observed:prior.time;
    times.set(v.id,time>=created && time<=now?time:NaN);
    if(!prior || (v.image_hash && observed>=created && observed<=now)) {
      state.set(v.fb_post_id,{time,image_hash:v.image_hash,caption_hash:v.caption_hash,
        observed:observed>=created && observed<=now?observed:created});
    }
  }
  return times;
}
