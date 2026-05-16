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
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);
        let upstream;
        try {
          upstream = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': env.CLAUDE_API_KEY,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': 'web-search-2025-03-05',
            },
            body,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        const data = await upstream.text();
        return cors(data, upstream.status);
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // GET /groq/test — raw debug call to Groq
    if (path === '/groq/test' && request.method === 'GET') {
      try {
        const testBody = {
          model: 'groq/compound',
          messages: [{ role: 'user', content: 'say hi' }],
          max_completion_tokens: 100,
        };
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + env.GROQ_API_KEY,
          },
          body: JSON.stringify(testBody),
        });
        const raw = await r.text();
        return cors(JSON.stringify({ status: r.status, groq_key_set: !!env.GROQ_API_KEY, body: raw }));
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // POST /groq — proxy to Groq (OpenAI-compatible), convert Anthropic↔OpenAI format
    if (path === '/groq' && request.method === 'POST') {
      try {
        const body = await request.json();
        console.log('[groq] messages count:', body.messages?.length, 'has system:', !!body.system);

        // Extract system message; flatten any complex (array) content to plain text
        let systemMsg = (body.system || '').slice(0, 4000); // cap system prompt for Groq
        const messages = (body.messages || []).filter(m => {
          if (m.role === 'system') { systemMsg = String(m.content).slice(0, 4000); return false; }
          return true;
        }).map(m => ({
          role: m.role,
          // Groq only accepts string content — flatten Anthropic content blocks
          content: Array.isArray(m.content)
            ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\n') || '[media]'
            : String(m.content || ''),
        }));

        const groqBody = {
          model: 'groq/compound',
          max_completion_tokens: 2000,
          messages: [
            ...(systemMsg ? [{ role: 'system', content: systemMsg }] : []),
            ...messages,
          ],
        };

        console.log('[groq] sending to Groq, total messages:', groqBody.messages.length, 'body size:', JSON.stringify(groqBody).length);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);
        let upstream;
        try {
          upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + env.GROQ_API_KEY,
            },
            body: JSON.stringify(groqBody),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        const rawText = await upstream.text();
        console.log('[groq] status:', upstream.status, 'response:', rawText.slice(0, 500));

        const groqData = JSON.parse(rawText);
        const text = groqData.choices?.[0]?.message?.content || '';
        console.log('[groq] extracted text length:', text.length);

        const anthropicResp = {
          id: groqData.id || 'groq-resp',
          type: 'message',
          role: 'assistant',
          model: 'groq/compound',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: text || (groqData.error?.message ? '[Groq error: ' + groqData.error.message + ']' : 'No response') }],
        };
        return cors(JSON.stringify(anthropicResp), upstream.status);
      } catch (e) {
        console.log('[groq] exception:', e.message);
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // POST /memory/store — embed text and upsert into Vectorize
    if (path === '/memory/store' && request.method === 'POST') {
      try {
        const { uid, conversationId, text, summary, ts } = await request.json();
        if (!uid || !text) return cors(JSON.stringify({ error: 'Missing uid or text' }), 400);
        const embRes = await fetch(
          'https://api.cloudflare.com/client/v4/accounts/' + env.CF_ACCOUNT_ID + '/ai/run/@cf/baai/bge-small-en-v1.5',
          {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + env.CF_AI_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text.slice(0, 512) }),
          }
        );
        const embData = await embRes.json();
        const embedding = embData.result?.data?.[0];
        if (!embedding) return cors(JSON.stringify({ error: 'Embedding failed' }), 500);
        await env.ARIA_MEMORY.upsert([{
          id: uid + '_' + (conversationId || Date.now()),
          values: embedding,
          metadata: { uid, summary: (summary || text).slice(0, 300), ts: ts || Date.now() },
        }]);
        return cors(JSON.stringify({ success: true }));
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // POST /memory/search — semantic search in Vectorize
    if (path === '/memory/search' && request.method === 'POST') {
      try {
        const { uid, query, limit } = await request.json();
        if (!uid || !query) return cors(JSON.stringify([]), 200);
        const embRes = await fetch(
          'https://api.cloudflare.com/client/v4/accounts/' + env.CF_ACCOUNT_ID + '/ai/run/@cf/baai/bge-small-en-v1.5',
          {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + env.CF_AI_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: query.slice(0, 512) }),
          }
        );
        const embData = await embRes.json();
        const embedding = embData.result?.data?.[0];
        if (!embedding) return cors(JSON.stringify([]));
        const results = await env.ARIA_MEMORY.query(embedding, {
          topK: limit || 5,
          filter: { uid },
          returnMetadata: 'all',
        });
        const hits = (results.matches || [])
          .filter(m => m.score > 0.5)
          .map(m => ({ summary: m.metadata?.summary || '', ts: m.metadata?.ts || 0, score: m.score }));
        return cors(JSON.stringify(hits));
      } catch (e) {
        return cors(JSON.stringify([]));
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

    // GET /gmail/auth — redirect to Google OAuth consent screen
    if (path === '/gmail/auth') {
      const clientId = env.GMAIL_CLIENT_ID;
      if (!clientId) return cors(JSON.stringify({ error: 'GMAIL_CLIENT_ID not configured' }), 500);
      const redirectUri = new URL('/gmail/callback', url.origin).toString();
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send');
      authUrl.searchParams.set('access_type', 'online');
      authUrl.searchParams.set('prompt', 'consent');
      return Response.redirect(authUrl.toString(), 302);
    }

    // GET /gmail/callback — exchange code, postMessage token back to opener
    if (path === '/gmail/callback') {
      const code = url.searchParams.get('code');
      const oauthError = url.searchParams.get('error');
      const html = (msg) => new Response(
        `<!DOCTYPE html><html><body><script>window.opener&&window.opener.postMessage(${JSON.stringify(msg)},'*');window.close();<\/script></body></html>`,
        { headers: { 'Content-Type': 'text/html', ...CORS } }
      );
      if (oauthError || !code) return html({ type: 'gmail_auth_error', error: oauthError || 'no_code' });
      try {
        const redirectUri = new URL('/gmail/callback', url.origin).toString();
        const params = new URLSearchParams({
          code, client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET,
          redirect_uri: redirectUri, grant_type: 'authorization_code',
        });
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) return html({ type: 'gmail_auth_error', error: tokenData.error || 'no_token' });
        return html({ type: 'gmail_auth_success', token: tokenData.access_token });
      } catch (e) {
        return html({ type: 'gmail_auth_error', error: e.message });
      }
    }

    // GET /gmail/messages — fetch inbox metadata
    if (path === '/gmail/messages') {
      const auth = request.headers.get('Authorization');
      if (!auth) return cors(JSON.stringify({ error: 'Missing Authorization' }), 401);
      try {
        const listRes = await fetch(
          'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&labelIds=INBOX',
          { headers: { Authorization: auth } }
        );
        const listData = await listRes.json();
        if (listData.error) return cors(JSON.stringify({ error: listData.error.message }), listRes.status);
        if (!listData.messages?.length) return cors(JSON.stringify({ messages: [] }));
        const messages = await Promise.all(
          listData.messages.map(async (m) => {
            const r = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
              { headers: { Authorization: auth } }
            );
            const msg = await r.json();
            const hdrs = msg.payload?.headers || [];
            const get = (n) => hdrs.find(h => h.name === n)?.value || '';
            return { id: m.id, subject: get('Subject'), from: get('From'), date: get('Date') };
          })
        );
        return cors(JSON.stringify({ messages }));
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // POST /gmail/send — send email via Gmail API
    if (path === '/gmail/send' && request.method === 'POST') {
      const auth = request.headers.get('Authorization');
      if (!auth) return cors(JSON.stringify({ error: 'Missing Authorization' }), 401);
      try {
        const { to, subject, body } = await request.json();
        const raw = ['To: ' + to, 'Subject: ' + subject, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
        const encoded = btoa(unescape(encodeURIComponent(raw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw: encoded }),
        });
        const sendData = await sendRes.json();
        if (sendData.id) return cors(JSON.stringify({ success: true, id: sendData.id }));
        return cors(JSON.stringify({ success: false, error: sendData.error?.message || 'Send failed' }), 400);
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // Default
    return new Response('ARIA Backend OK', {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'text/plain' },
    });
  },
};
