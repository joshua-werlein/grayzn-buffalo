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
