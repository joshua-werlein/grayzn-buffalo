// Facebook feed Worker — runs on a cron, caches posts in KV.
// Deploy separately: wrangler deploy (from this folder with its own wrangler.toml)
// Bindings needed: FB_KV (KV), FB_PAGE_ID + FB_SYSTEM_TOKEN (secrets from Meta Business Manager System User)
export default {
  async scheduled(event, env, ctx) {
    const url = `https://graph.facebook.com/v21.0/${env.FB_PAGE_ID}/posts?fields=message,created_time,permalink_url,full_picture&limit=6&access_token=${env.FB_SYSTEM_TOKEN}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    await env.FB_KV.put('fb:feed', JSON.stringify(data.data ?? []), { expirationTtl: 3600 });
  },
  async fetch(request, env) {
    const feed = await env.FB_KV.get('fb:feed');
    return new Response(feed ?? '[]', {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' },
    });
  },
};
