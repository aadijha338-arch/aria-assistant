const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function cors(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...extra },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: CORS });
    }

    // POST /claude — proxy to Anthropic
    if (path === '/claude' && request.method === 'POST') {
      try {
        const body = await request.text();
        const upstream = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body,
        });
        const data = await upstream.text();
        return cors(data, upstream.status);
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // GET /api/crypto — CoinGecko proxy
    if (path === '/api/crypto') {
      try {
        const params = url.searchParams.toString();
        const upstream = await fetch(
          'https://api.coingecko.com/api/v3/simple/price' + (params ? '?' + params : ''),
          { headers: { 'User-Agent': 'ARIA-Assistant/1.0' } }
        );
        const data = await upstream.text();
        return cors(data, upstream.status);
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // GET /api/news — NewsAPI proxy
    if (path === '/api/news') {
      try {
        const params = new URLSearchParams(url.searchParams);
        const hasCategory = params.has('category');
        const endpoint = hasCategory
          ? 'https://newsapi.org/v2/top-headlines'
          : 'https://newsapi.org/v2/everything';
        const upstream = await fetch(endpoint + '?' + params.toString());
        const data = await upstream.text();
        return cors(data, upstream.status);
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // GET /api/metals — static response
    if (path === '/api/metals') {
      return cors(JSON.stringify([{ gold: 3300 }]));
    }

    // POST /gmail/token — OAuth code exchange
    if (path === '/gmail/token' && request.method === 'POST') {
      try {
        const body = await request.json();
        const params = new URLSearchParams({
          code: body.code,
          client_id: env.GMAIL_CLIENT_ID,
          client_secret: env.GMAIL_CLIENT_SECRET,
          redirect_uri: body.redirect_uri || 'postmessage',
          grant_type: 'authorization_code',
        });
        const upstream = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });
        const data = await upstream.text();
        return cors(data, upstream.status);
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // ── Files via R2 ──────────────────────────────────────────────────

    // POST /files/generate — Claude writes content, store in R2, return URL
    if (path === '/files/generate' && request.method === 'POST') {
      try {
        const { userId, fileName, content, contentType } = await request.json();
        const uid = userId || 'anon';
        const key = uid + '/' + Date.now() + '_' + (fileName || 'file.txt');
        await env.FILES.put(key, content, {
          httpMetadata: { contentType: contentType || 'text/plain' },
          customMetadata: { userId: uid, fileName: fileName || 'file.txt' },
        });
        const downloadUrl = url.origin + '/files/content?key=' + encodeURIComponent(key);
        return cors(JSON.stringify({ success: true, url: downloadUrl, key, fileName }));
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // GET /files/list — list files for a user
    if (path === '/files/list') {
      try {
        const userId = url.searchParams.get('userId') || 'anon';
        const list = await env.FILES.list({ prefix: userId + '/' });
        const files = list.objects.map(o => ({
          key: o.key,
          fileName: o.customMetadata?.fileName || o.key.split('/').pop(),
          size: o.size,
          uploaded: o.uploaded,
          url: url.origin + '/files/content?key=' + encodeURIComponent(o.key),
        }));
        return cors(JSON.stringify({ files }));
      } catch (e) {
        return cors(JSON.stringify({ files: [], error: e.message }), 500);
      }
    }

    // POST /files/upload — raw file upload to R2
    if (path === '/files/upload' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const file = formData.get('file');
        const userId = formData.get('userId') || 'anon';
        const fileName = file?.name || 'upload.bin';
        const key = userId + '/' + Date.now() + '_' + fileName;
        const bytes = await file.arrayBuffer();
        await env.FILES.put(key, bytes, {
          httpMetadata: { contentType: file.type || 'application/octet-stream' },
          customMetadata: { userId, fileName },
        });
        const downloadUrl = url.origin + '/files/content?key=' + encodeURIComponent(key);
        return cors(JSON.stringify({ success: true, url: downloadUrl, key, fileName }));
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // GET /files/content — serve a file from R2
    if (path === '/files/content') {
      try {
        const key = url.searchParams.get('key');
        if (!key) return cors(JSON.stringify({ error: 'Missing key' }), 400);
        const obj = await env.FILES.get(key);
        if (!obj) return cors(JSON.stringify({ error: 'Not found' }), 404);
        const ct = obj.httpMetadata?.contentType || 'application/octet-stream';
        const headers = { ...CORS, 'Content-Type': ct };
        const fn = obj.customMetadata?.fileName;
        if (fn) headers['Content-Disposition'] = 'attachment; filename="' + fn + '"';
        return new Response(obj.body, { status: 200, headers });
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // DELETE /files/delete — delete a file from R2
    if (path === '/files/delete') {
      try {
        const key = url.searchParams.get('key');
        if (!key) return cors(JSON.stringify({ error: 'Missing key' }), 400);
        await env.FILES.delete(key);
        return cors(JSON.stringify({ success: true }));
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // Gmail read/send — placeholder (full implementation needs OAuth token storage)
    if (path.startsWith('/gmail/')) {
      return cors(JSON.stringify({ error: 'Gmail route not configured' }), 404);
    }

    // Default
    return new Response('ARIA Backend OK', {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'text/plain' },
    });
  },
};
