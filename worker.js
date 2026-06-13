const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-File-Name, X-File-Type, X-User-Id',
};

function cors(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...extra },
  });
}

// Fetch ARIA's live self-awareness block from the skill-system worker (service
// binding). Logs the length and any error (does NOT silently swallow) so a
// failing fetch is visible in `wrangler tail`. Returns '' on any failure.
async function fetchSelfContext(env) {
  try {
    if (!env.SKILL_SYSTEM) { console.log('[selfctx] SKILL_SYSTEM binding missing'); return ''; }
    const res = await env.SKILL_SYSTEM.fetch(new Request('https://skill-system.internal/api/context'));
    if (!res.ok) { console.log('[selfctx] /api/context HTTP ' + res.status); return ''; }
    const text = (await res.text()).trim();
    console.log('[selfctx] selfContext length=' + text.length);
    return text;
  } catch (e) {
    console.log('[selfctx] fetch error: ' + (e && e.message ? e.message : String(e)));
    return '';
  }
}

// ---- Shared conversation memory (one brain across terminal + phone + web) ----
// Reads/writes the skill-system's /api/memory via the service binding. Fail-open.
async function fetchSharedMemory(env, limit = 24) {
  try {
    if (!env.SKILL_SYSTEM || !env.SKILL_UPDATE_TOKEN) return [];
    const res = await env.SKILL_SYSTEM.fetch(new Request('https://skill-system.internal/api/memory?limit=' + limit, { headers: { 'X-Skill-Token': env.SKILL_UPDATE_TOKEN } }));
    if (!res.ok) { console.log('[mem] GET HTTP ' + res.status); return []; }
    const d = await res.json();
    return Array.isArray(d.messages) ? d.messages : [];
  } catch (e) { console.log('[mem] fetch error: ' + e.message); return []; }
}
function memoryBlock(messages) {
  if (!messages || !messages.length) return '';
  const lines = messages.slice(-24).map((m) => (m.role === 'assistant' ? 'ARIA' : 'User') + ': ' + String(m.content || '').slice(0, 500));
  return "SHARED CONVERSATION MEMORY — this is your own recent conversation with Aadi across all his devices (terminal, phone, web). Treat it as your memory and recall these facts when asked:\n" + lines.join('\n');
}
async function appendSharedMemory(env, pair, source) {
  try {
    if (!env.SKILL_SYSTEM || !env.SKILL_UPDATE_TOKEN) return;
    await env.SKILL_SYSTEM.fetch(new Request('https://skill-system.internal/api/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Skill-Token': env.SKILL_UPDATE_TOKEN },
      body: JSON.stringify({ messages: pair, source }),
    }));
  } catch (e) { console.log('[mem] append error: ' + e.message); }
}
function lastUserText(messages) {
  const flatten = (c) => Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : String(c == null ? '' : c);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return flatten(messages[i].content);
  }
  return '';
}

// ARIA runs entirely on Gemini + DeepSeek — no Anthropic/Claude dependency.
// Convert an Anthropic-style content value (string OR block array) into Gemini
// `parts`, preserving base64 images so vision (e.g. mood detection) keeps working.
function toGeminiParts(content) {
  if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'text') parts.push({ text: b.text || '' });
      else if (b.type === 'image' && b.source?.type === 'base64') {
        parts.push({ inlineData: { mimeType: b.source.media_type || 'image/jpeg', data: b.source.data } });
      }
    }
    return parts.length ? parts : [{ text: '' }];
  }
  return [{ text: String(content == null ? '' : content) }];
}

// Unified native generation from an Anthropic-style { system, messages } payload.
// Gemini first (optional Google Search grounding + image/vision passthrough),
// then DeepSeek text fallback. Returns { text, model } or null.
async function generate(env, systemPrompt, messages, opts = {}) {
  const { search = false, maxTokens = 3000 } = opts;
  const convo = (messages || []).filter(m => m.role !== 'system');

  if (env.GEMINI_API_KEY) {
    try {
      const contents = convo.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: toGeminiParts(m.content) }));
      const gBody = {
        ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
        contents,
        ...(search ? { tools: [{ googleSearch: {} }] } : {}),
        generationConfig: { maxOutputTokens: maxTokens },
      };
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + (env.GEMINI_MODEL || 'gemini-2.5-flash') + ':generateContent?key=' + env.GEMINI_API_KEY,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gBody) });
      if (r.ok) {
        const d = await r.json();
        const t = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        if (t) return { text: t, model: 'gemini' };
        console.log('[generate] gemini empty response');
      } else { console.log('[generate] gemini HTTP ' + r.status); }
    } catch (e) { console.log('[generate] gemini error: ' + e.message); }
  }

  if (env.DEEPSEEK_API_KEY) {
    try {
      const flatten = (c) => Array.isArray(c)
        ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n')
        : String(c == null ? '' : c);
      const dsMsgs = [];
      if (systemPrompt) dsMsgs.push({ role: 'system', content: systemPrompt });
      for (const m of convo) dsMsgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: flatten(m.content) });
      const r = await fetch('https://api.deepseek.com/v1/chat/completions',
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.DEEPSEEK_API_KEY }, body: JSON.stringify({ model: env.DEEPSEEK_MODEL || 'deepseek-chat', messages: dsMsgs, max_tokens: maxTokens }) });
      if (r.ok) {
        const d = await r.json();
        const t = d.choices?.[0]?.message?.content || '';
        if (t) return { text: t, model: 'deepseek' };
      } else { console.log('[generate] deepseek HTTP ' + r.status); }
    } catch (e) { console.log('[generate] deepseek error: ' + e.message); }
  }
  return null;
}

// ---- Native language analysis (ported from aria-neural, zero-LLM) ----
// Fast regex intent / entity / sentiment / urgency extraction. Runs before any
// model call so ARIA can route and self-classify for free (no tokens).
const INTENT_PATTERNS = [
  { intent: 'question', re: /\b(what|who|where|when|why|how|which|whose|whom)\b/i },
  { intent: 'command', re: /\b(do|make|create|build|write|generate|set|schedule|remind|send|delete|remove|update|change|fix|run|start|stop|deploy|commit)\b/i },
  { intent: 'planning', re: /\b(plan|roadmap|milestone|phase|strategy|steps|timeline)\b/i },
  { intent: 'reasoning', re: /\b(explain|reason|because|logic|deduce|infer|prove|analyze)\b/i },
  { intent: 'memory', re: /\b(remember|recall|history|past|previous|memory|what did|tell me about)\b/i },
  { intent: 'prediction', re: /\b(will|could|would|might|predict|forecast|expect|likely|probably|estimate)\b/i },
  { intent: 'greeting', re: /\b(hi|hello|hey|greetings|good morning|good evening|good night|howdy)\b/i },
];
const ENTITY_PATTERNS = [
  { type: 'email', re: /\b([\w.+-]+@[\w-]+\.[\w.]+)\b/g },
  { type: 'date', re: /\b(\d{4}-\d{2}-\d{2})\b/g },
  { type: 'time', re: /\b(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?)\b/gi },
  { type: 'currency', re: /\b(NPR|USD|EUR|GBP|INR)\s*(\d+[\d,.]*)\b/gi },
  { type: 'url', re: /\b(https?:\/\/[\w./-]+)\b/g },
];
const POSITIVE_WORDS = /\b(great|thanks|awesome|love|excellent|good|perfect|amazing|wonderful|helpful|fantastic|brilliant|nice|glad|happy)\b/gi;
const NEGATIVE_WORDS = /\b(bad|terrible|awful|wrong|broken|hate|stupid|useless|error|fail|waste|slow|buggy|annoying|disappointed|poor)\b/gi;
const URGENT_WORDS = /\b(urgent|asap|immediately|emergency|hurry|critical|right now|top priority)\b/i;
const FRESH_WORDS = /\b(latest|today|tonight|currently|current|recent|news|headline|headlines|price|stock|crypto|weather|score|breaking|this (week|month|year)|2024|2025|2026)\b/i;

function classify(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  const intents = [];
  for (const { intent, re } of INTENT_PATTERNS) {
    const m = lower.match(new RegExp(re.source, 'gi'));
    if (m) intents.push({ intent, score: m.length });
  }
  intents.sort((a, b) => b.score - a.score);
  const entities = {};
  for (const { type, re } of ENTITY_PATTERNS) {
    const found = t.match(re);
    if (found) entities[type] = [...new Set(found.map(s => s.trim()))];
  }
  const pos = (lower.match(POSITIVE_WORDS) || []).length;
  const neg = (lower.match(NEGATIVE_WORDS) || []).length;
  return {
    primaryIntent: intents[0]?.intent || 'statement',
    intents: intents.map(i => i.intent),
    entities,
    sentiment: pos > neg ? 'positive' : neg > pos ? 'negative' : 'neutral',
    urgent: URGENT_WORDS.test(lower),
    needsFreshInfo: FRESH_WORDS.test(lower),
  };
}

function hasImages(messages) {
  return (messages || []).some(m => Array.isArray(m.content) && m.content.some(b => b && b.type === 'image'));
}

// ---- Graph memory (associative recall over Vectorize) ----
// Upgrades flat top-K vector search into a memory graph: each stored memory is a
// node (a Vectorize vector + metadata), nodes are linked by weighted edges held
// in metadata.connections, and recall blends semantic similarity with spreading
// activation across those edges. Ported from aria-neural/memory-graph.ts and
// adapted to run on the existing Vectorize binding alone — no extra storage.
// Node strength decays lazily at read time (no cron / full scan needed).
const GRAPH = {
  decayFactor: 0.5,  // activation retained per hop
  maxDepth: 3,       // spreading-activation hop limit
  threshold: 0.12,   // min activation to keep traversing
  dailyDecay: 0.01,  // strength decay per day since last access
  seedK: 6,          // semantic seeds pulled per query
  linkK: 3,          // similar nodes auto-linked when a memory is stored
  maxEdges: 32,      // cap fan-out per node (keeps metadata < 10KiB)
  simLink: 0.6,      // min similarity to auto-link on store
  seedMin: 0.4,      // min similarity for a node to seed recall
};

async function embed(env, text) {
  const r = await fetch(
    'https://api.cloudflare.com/client/v4/accounts/' + env.CF_ACCOUNT_ID + '/ai/run/@cf/baai/bge-small-en-v1.5',
    { method: 'POST', headers: { 'Authorization': 'Bearer ' + env.CF_AI_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: String(text || '').slice(0, 512) }) }
  );
  const d = await r.json();
  return d.result?.data?.[0] || null;
}

function parseConns(meta) {
  try { return JSON.parse(meta?.connections || '[]'); } catch { return []; }
}
function addEdge(meta, to, type, weight) {
  const c = parseConns(meta);
  const ex = c.find(x => x.to === to);
  if (ex) ex.weight = Math.min(1, Math.max(ex.weight, weight));
  else c.push({ to, type, weight });
  meta.connections = JSON.stringify(c.slice(-GRAPH.maxEdges));
}
function reverseRel(type) {
  const r = { causes: 'caused_by', caused_by: 'causes', before: 'after', after: 'before', depends_on: 'required_by', required_by: 'depends_on', co_occurrence: 'co_occurrence' };
  return r[type] || 'related_to';
}
// effective strength after time decay since last access
function effStrength(meta) {
  const s = Number(meta?.strength ?? 0.5);
  const last = Number(meta?.lastAccessed ?? meta?.ts ?? Date.now());
  const days = Math.max(0, (Date.now() - last) / 86400000);
  return Math.max(0.05, s * Math.exp(-GRAPH.dailyDecay * days));
}

async function getNodes(env, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const vecs = await env.ARIA_MEMORY.getByIds(ids);
  for (const v of (vecs || [])) map.set(v.id, v);
  return map;
}

// Spreading activation from seed nodes over the edge graph. Returns id -> activation.
async function spread(env, seeds) {
  const visited = new Map();
  let frontier = seeds.map(s => ({ id: s.id, activation: s.activation }));
  for (const s of frontier) visited.set(s.id, s.activation);
  for (let depth = 0; depth < GRAPH.maxDepth && frontier.length; depth++) {
    const map = await getNodes(env, frontier.map(f => f.id));
    const next = [];
    for (const f of frontier) {
      const node = map.get(f.id);
      if (!node) continue;
      for (const c of parseConns(node.metadata)) {
        const act = f.activation * c.weight * GRAPH.decayFactor;
        if (act < GRAPH.threshold) continue;
        if (!visited.has(c.to) || visited.get(c.to) < act) {
          visited.set(c.to, act);
          next.push({ id: c.to, activation: act });
        }
      }
    }
    frontier = next;
  }
  return visited;
}

// Hebbian reinforcement: co-activated seeds wire together; bump access recency.
// `seeds` are Vectorize matches carrying both values and metadata.
async function reinforceSeeds(env, seeds) {
  try {
    const byId = new Map(seeds.map(m => [m.id, { id: m.id, values: m.values, metadata: { ...m.metadata } }]));
    const ids = [...byId.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        addEdge(byId.get(ids[i]).metadata, ids[j], 'co_occurrence', 0.45);
        addEdge(byId.get(ids[j]).metadata, ids[i], 'co_occurrence', 0.45);
      }
    }
    const now = Date.now();
    for (const n of byId.values()) {
      n.metadata.lastAccessed = now;
      n.metadata.strength = Math.min(1, Number(n.metadata.strength || 0.5) + 0.02);
    }
    const batch = [...byId.values()].filter(n => n.values);
    if (batch.length) await env.ARIA_MEMORY.upsert(batch);
  } catch (e) { console.log('[mem] reinforce error: ' + e.message); }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: CORS });
    }

    // POST /claude — DEFAULT chat path. No longer proxies to Anthropic: ARIA runs
    // on Gemini (+ Google Search grounding & vision) → DeepSeek. The endpoint name
    // and Anthropic-shaped response are kept so the frontend needs no changes.
    if (path === '/claude' && method === 'POST') {
      try {
        const payloadObj = await request.json();
        const messages = payloadObj.messages || [];

        // Prepend ARIA's live self-awareness block + shared cross-device memory
        // so the default chat knows its own skills and recalls prior chats. Fail-open.
        let systemPrompt = typeof payloadObj.system === 'string' ? payloadObj.system : '';
        const selfCtx = await fetchSelfContext(env);
        const mem = memoryBlock(await fetchSharedMemory(env));
        const prefix = [selfCtx, mem].filter(Boolean).join('\n\n');
        if (prefix) systemPrompt = prefix + (systemPrompt ? '\n\n' + systemPrompt : '');

        // Enable Google Search grounding when the caller asked for web_search, OR
        // when the native classifier detects a time-sensitive query. Skip when the
        // turn carries images (grounding + inline media don't mix).
        const toolWantsSearch = Array.isArray(payloadObj.tools) &&
          payloadObj.tools.some(t => String(t.type || '').includes('web_search') || t.name === 'web_search');
        const u = lastUserText(messages);
        const intel = classify(u);
        const images = hasImages(messages);
        const search = (toolWantsSearch || intel.needsFreshInfo) && !images;
        console.log('[claude] intent=' + intel.primaryIntent + ' search=' + search + ' urgent=' + intel.urgent);

        const gen = await generate(env, systemPrompt, messages, { search, maxTokens: payloadObj.max_tokens || 3000 });
        if (!gen) return cors(JSON.stringify({ error: 'All providers failed (Gemini + DeepSeek)' }), 502);

        if (u && gen.text) ctx.waitUntil(appendSharedMemory(env, [{ role: 'user', content: u }, { role: 'assistant', content: gen.text }], 'web/app'));
        return cors(JSON.stringify({
          id: 'aria-' + gen.model, type: 'message', role: 'assistant', model: gen.model,
          stop_reason: 'end_turn', content: [{ type: 'text', text: gen.text }],
        }), 200);
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // POST /analyze — native zero-LLM language analysis (intent/entities/sentiment)
    if (path === '/analyze' && method === 'POST') {
      try {
        const { text } = await request.json();
        return cors(JSON.stringify(classify(text || '')), 200);
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // POST /gemini — proxy to Google Gemini with Google Search grounding, with DeepSeek fallback
    if (path === '/gemini' && method === 'POST') {
      try {
        const body = await request.json();

        // Extract system message; flatten complex content to text
        let systemPrompt = body.system || '';
        const rawMessages = (body.messages || []).filter(m => {
          if (m.role === 'system') { systemPrompt = String(m.content); return false; }
          return true;
        });

        // Prepend ARIA's live self-awareness context + shared cross-device memory
        // so the main chat knows its own skills and recalls prior conversations.
        // Fail-open: any error just skips the prepend.
        {
          const selfCtx = await fetchSelfContext(env);
          const mem = memoryBlock(await fetchSharedMemory(env));
          const prefix = [selfCtx, mem].filter(Boolean).join('\n\n');
          if (prefix) systemPrompt = prefix + (systemPrompt ? '\n\n' + systemPrompt : '');
        }

        // Convert to Gemini contents format
        const contents = rawMessages.map(m => {
          let text = '';
          if (Array.isArray(m.content)) {
            text = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n') || '[media]';
          } else {
            text = String(m.content || '');
          }
          return {
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text }],
          };
        });

        const geminiBody = {
          ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
          contents,
          tools: [{ googleSearch: {} }],
          generationConfig: { maxOutputTokens: 3000 },
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);
        let upstream;
        let geminiError = null;
        let geminiText = '';

        try {
          upstream = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + env.GEMINI_API_KEY,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(geminiBody),
              signal: controller.signal,
            }
          );
          if (!upstream.ok) {
            geminiError = `Gemini HTTP status ${upstream.status}`;
          } else {
            const geminiData = await upstream.json();
            if (geminiData.error) {
              geminiError = geminiData.error.message || 'Gemini error';
            } else {
              geminiText = geminiData.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
              if (!geminiText) {
                geminiError = 'Empty response from Gemini';
              }
            }
          }
        } catch (e) {
          geminiError = e.message;
        } finally {
          clearTimeout(timer);
        }

        // If Gemini succeeded and returned text, use it
        if (!geminiError && geminiText) {
          const u = lastUserText(rawMessages);
          if (u) ctx.waitUntil(appendSharedMemory(env, [{ role: 'user', content: u }, { role: 'assistant', content: geminiText }], 'web/app'));
          const anthropicResp = {
            id: 'gemini-resp',
            type: 'message',
            role: 'assistant',
            model: 'gemini-2.5-flash',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: geminiText }],
          };
          return cors(JSON.stringify(anthropicResp), 200);
        }

        // Otherwise, fallback to DeepSeek
        if (env.DEEPSEEK_API_KEY) {
          const deepseekMessages = [];
          if (systemPrompt) {
            deepseekMessages.push({ role: 'system', content: systemPrompt });
          }
          for (const m of rawMessages) {
            let text = '';
            if (Array.isArray(m.content)) {
              text = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n') || '[media]';
            } else {
              text = String(m.content || '');
            }
            deepseekMessages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text });
          }

          const dsController = new AbortController();
          const dsTimer = setTimeout(() => dsController.abort(), 60000);
          try {
            const dsUpstream = await fetch('https://api.deepseek.com/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
              },
              body: JSON.stringify({
                model: env.DEEPSEEK_MODEL || 'deepseek-chat',
                messages: deepseekMessages,
                temperature: 0.7,
                max_tokens: 3000,
              }),
              signal: dsController.signal,
            });

            if (dsUpstream.ok) {
              const dsData = await dsUpstream.json();
              const dsText = dsData.choices?.[0]?.message?.content || '';
              const u = lastUserText(rawMessages);
              if (u && dsText) ctx.waitUntil(appendSharedMemory(env, [{ role: 'user', content: u }, { role: 'assistant', content: dsText }], 'web/app'));
              const anthropicResp = {
                id: 'deepseek-fallback-resp',
                type: 'message',
                role: 'assistant',
                model: dsData.model || env.DEEPSEEK_MODEL || 'deepseek-chat',
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: dsText }],
              };
              return cors(JSON.stringify(anthropicResp), 200);
            } else {
              const errText = await dsUpstream.text();
              return cors(JSON.stringify({ error: `Gemini failed (${geminiError}) and DeepSeek fallback failed: ${errText}` }), dsUpstream.status);
            }
          } catch (dsErr) {
            return cors(JSON.stringify({ error: `Gemini failed (${geminiError}) and DeepSeek fallback threw: ${dsErr.message}` }), 500);
          } finally {
            clearTimeout(dsTimer);
          }
        } else {
          // No DeepSeek configured, return Gemini error
          return cors(JSON.stringify({ error: `Gemini failed: ${geminiError}. DeepSeek fallback is not configured.` }), 500);
        }
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // POST /memory/store — embed text, store as a graph node, and auto-link it to
    // semantically similar existing memories (hebbian: related memories wire together).
    if (path === '/memory/store' && method === 'POST') {
      try {
        const { uid, conversationId, text, summary, ts } = await request.json();
        if (!uid || !text) return cors(JSON.stringify({ error: 'Missing uid or text' }), 400);
        const embedding = await embed(env, text);
        if (!embedding) return cors(JSON.stringify({ error: 'Embedding failed' }), 500);

        const id = uid + '_' + (conversationId || Date.now());
        const now = Date.now();
        const metadata = { uid, type: 'episode', summary: (summary || text).slice(0, 300), ts: ts || now, strength: 0.8, lastAccessed: now, connections: '[]' };

        // Find similar existing memories and wire bidirectional edges in one batch.
        let linked = [];
        try {
          const sim = await env.ARIA_MEMORY.query(embedding, { topK: GRAPH.linkK + 1, filter: { uid }, returnMetadata: 'all', returnValues: true });
          linked = (sim.matches || []).filter(m => m.id !== id && m.score >= GRAPH.simLink).slice(0, GRAPH.linkK);
        } catch (e) { console.log('[mem] link query failed: ' + e.message); }

        metadata.connections = JSON.stringify(linked.map(m => ({ to: m.id, type: 'related_to', weight: Math.min(1, m.score) })));
        const batch = [{ id, values: embedding, metadata }];
        for (const m of linked) {
          const meta = { ...m.metadata };
          addEdge(meta, id, 'related_to', Math.min(1, m.score) * 0.6);
          if (m.values) batch.push({ id: m.id, values: m.values, metadata: meta });
        }
        await env.ARIA_MEMORY.upsert(batch);
        return cors(JSON.stringify({ success: true, id, linked: linked.length }));
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // POST /memory/search — graph recall: semantic seeds + spreading activation.
    // Surfaces memories that aren't a direct semantic match but are linked to ones
    // that are. Back-compatible shape: [{ summary, ts, score, via }].
    if (path === '/memory/search' && method === 'POST') {
      try {
        const { uid, query, limit } = await request.json();
        if (!uid || !query) return cors(JSON.stringify([]), 200);
        const embedding = await embed(env, query);
        if (!embedding) return cors(JSON.stringify([]));
        const k = limit || 5;

        const res = await env.ARIA_MEMORY.query(embedding, { topK: Math.max(k, GRAPH.seedK), filter: { uid }, returnMetadata: 'all', returnValues: true });
        const seedMatches = (res.matches || []).filter(m => m.score > GRAPH.seedMin);
        if (!seedMatches.length) return cors(JSON.stringify([]));

        const seedMeta = new Map(seedMatches.map(m => [m.id, m]));
        const activation = await spread(env, seedMatches.map(m => ({ id: m.id, activation: m.score })));

        // Pull metadata for spread-only (associative) nodes not already in seeds.
        const extra = await getNodes(env, [...activation.keys()].filter(id => !seedMeta.has(id)));

        const scored = [];
        for (const [id, act] of activation) {
          const isSeed = seedMeta.has(id);
          const meta = isSeed ? seedMeta.get(id).metadata : extra.get(id)?.metadata;
          if (!meta || meta.uid !== uid) continue;
          const semantic = isSeed ? seedMeta.get(id).score : 0;
          const score = Math.min(1, semantic * 0.7 + act * 0.45) * effStrength(meta);
          scored.push({ summary: meta.summary || '', ts: Number(meta.ts) || 0, score: Number(score.toFixed(4)), via: isSeed ? 'semantic' : 'associative' });
        }
        scored.sort((a, b) => b.score - a.score);

        // Hebbian: co-activated seeds wire together; refresh access recency.
        ctx.waitUntil(reinforceSeeds(env, seedMatches));
        return cors(JSON.stringify(scored.slice(0, k)));
      } catch (e) {
        console.log('[mem] search error: ' + e.message);
        return cors(JSON.stringify([]));
      }
    }

    // POST /memory/connect — manually link two memory nodes { aId, bId, type?, weight? }
    if (path === '/memory/connect' && method === 'POST') {
      try {
        const { aId, bId, type = 'related_to', weight = 0.6 } = await request.json();
        if (!aId || !bId || aId === bId) return cors(JSON.stringify({ error: 'aId and bId required and must differ' }), 400);
        const map = await getNodes(env, [aId, bId]);
        const a = map.get(aId), b = map.get(bId);
        if (!a || !b) return cors(JSON.stringify({ error: 'one or both nodes not found' }), 404);
        const am = { ...a.metadata }, bm = { ...b.metadata };
        addEdge(am, bId, type, weight);
        addEdge(bm, aId, reverseRel(type), weight * 0.6);
        await env.ARIA_MEMORY.upsert([{ id: a.id, values: a.values, metadata: am }, { id: b.id, values: b.values, metadata: bm }]);
        return cors(JSON.stringify({ success: true }));
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // GET /memory/node?id= — inspect a single node (debug): metadata + edges
    if (path === '/memory/node' && method === 'GET') {
      try {
        const id = url.searchParams.get('id');
        if (!id) return cors(JSON.stringify({ error: 'Missing id' }), 400);
        const map = await getNodes(env, [id]);
        const n = map.get(id);
        if (!n) return cors(JSON.stringify({ error: 'Not found' }), 404);
        return cors(JSON.stringify({ id, metadata: n.metadata, effectiveStrength: Number(effStrength(n.metadata).toFixed(4)), edges: parseConns(n.metadata) }), 200);
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

    // POST /files/generate — store caller-provided content in R2, return URL
    if (path === '/files/generate' && request.method === 'POST') {
      try {
        const { userId, fileName, content, contentType } = await request.json();
        const uid = userId || 'anon';
        const key = uid + '/' + Date.now() + '_' + (fileName || 'file.txt');
        await env.FILES.put(key, content, {
          httpMetadata: { contentType: contentType || 'text/plain' },
          customMetadata: { uid, fileName: fileName || 'file.txt', uploadedAt: String(Date.now()) },
        });
        const downloadUrl = url.origin + '/files/content?key=' + encodeURIComponent(key);
        return cors(JSON.stringify({ success: true, url: downloadUrl, key, fileName }));
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // POST /files/upload — raw bytes upload to R2
    if (path === '/files/upload' && request.method === 'POST') {
      try {
        const uid = request.headers.get('X-User-Id') || url.searchParams.get('uid') || url.searchParams.get('userId') || 'anon';
        const rawName = request.headers.get('X-File-Name') || 'upload.bin';
        const fileName = decodeURIComponent(rawName);
        const fileType = request.headers.get('X-File-Type') || request.headers.get('Content-Type') || 'application/octet-stream';
        const key = uid + '/' + Date.now() + '_' + fileName;
        const bytes = await request.arrayBuffer();
        await env.FILES.put(key, bytes, {
          httpMetadata: { contentType: fileType },
          customMetadata: { uid, fileName, uploadedAt: String(Date.now()) },
        });
        return cors(JSON.stringify({ success: true, key, fileName, fileType, size: bytes.byteLength }));
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // GET /files/list — list files for a user
    if (path === '/files/list') {
      try {
        const uid = url.searchParams.get('uid') || url.searchParams.get('userId') || 'anon';
        const list = await env.FILES.list({ prefix: uid + '/', include: ['customMetadata', 'httpMetadata'] });
        const files = list.objects.map(o => ({
          key: o.key,
          fileName: o.customMetadata?.fileName || o.key.split('/').pop(),
          size: o.size,
          uploadedAt: o.customMetadata?.uploadedAt ? Number(o.customMetadata.uploadedAt) : (o.uploaded ? new Date(o.uploaded).getTime() : 0),
          contentType: o.httpMetadata?.contentType || 'application/octet-stream',
        }));
        return cors(JSON.stringify({ files }));
      } catch (e) {
        return cors(JSON.stringify({ files: [], error: e.message }), 500);
      }
    }

    // GET /files/get — serve raw file bytes
    if (path === '/files/get') {
      try {
        const key = url.searchParams.get('key');
        if (!key) return cors(JSON.stringify({ error: 'Missing key' }), 400);
        const obj = await env.FILES.get(key);
        if (!obj) return cors(JSON.stringify({ error: 'Not found' }), 404);
        const ct = obj.httpMetadata?.contentType || 'application/octet-stream';
        const fn = obj.customMetadata?.fileName;
        const headers = { ...CORS, 'Content-Type': ct };
        if (fn) headers['Content-Disposition'] = 'inline; filename="' + fn + '"';
        return new Response(obj.body, { status: 200, headers });
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 500);
      }
    }

    // GET /files/content — return file as base64 JSON
    if (path === '/files/content') {
      try {
        const key = url.searchParams.get('key');
        if (!key) return cors(JSON.stringify({ error: 'Missing key' }), 400);
        const obj = await env.FILES.get(key);
        if (!obj) return cors(JSON.stringify({ error: 'Not found' }), 404);
        const contentType = obj.httpMetadata?.contentType || 'application/octet-stream';
        const fileName = obj.customMetadata?.fileName || key.split('/').pop();
        const bytes = await obj.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
        return cors(JSON.stringify({ contentType, type: contentType, base64, content: base64, fileName }));
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

    // GET /ruby/status — KGA bid status (proxies to agents-backend if configured, else returns seeded data)
    if (path === '/ruby/status' && method === 'GET') {
      if (env.AGENTS_BACKEND_URL) {
        try {
          const up = await fetch(env.AGENTS_BACKEND_URL + '/ruby/status');
          const data = await up.text();
          return cors(data, up.status);
        } catch {}
      }
      const deadline = new Date('2026-06-26T12:00:00+05:45');
      const daysLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 86400000));
      return cors(JSON.stringify({
        kga_bid: {
          project: 'NEA Kaligandaki A Hydropower Station Office Building',
          ifb: 'KGA-2082/83-CT-07',
          employer: 'NEA Engineering Company Ltd.',
          location: 'Syangja/Palpa District, Nepal',
          deadline: '2026-06-26',
          estimated_value: 'NPR 29.05 Crore',
          bid_security: 'NPR 1,45,000',
          days_left: daysLeft,
          status: 'pending',
          remaining_work: [
            'Get bid security NPR 1,45,000 from Nabil Bank',
            'Complete BOQ and Letter of Bid',
            'Sign, stamp, scan Letter of Bid to PDF',
            'Upload 11 mandatory documents to Bolpatra',
            'Submit bid before 12:00 hrs on 26 Jun',
          ],
        },
        active_tenders: 1,
        completed_tenders: 0,
      }), 200);
    }

    // POST /aadi/chat — route ARIA chat through the self-evolving skill system
    // (skill matching, approval loop, per-push GitHub confirmation), then map
    // its { response } back to the { reply } shape the frontend expects. Handled
    // here, ahead of the generic /aadi/* proxy below.
    if (path === '/aadi/chat' && method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        if (!body.message) return cors(JSON.stringify({ error: 'message is required' }), 400);
        const payload = JSON.stringify({
          message: body.message,
          // Stable session keeps multi-turn flows (e.g. the skill-push yes/no
          // confirmation) tied to the same conversation for this single user.
          sessionId: body.sessionId || 'aadi-web',
          userId: body.userId || 'aadij',
        });
        // Prefer a same-account service binding — worker-to-worker calls over
        // public workers.dev URLs are blocked (CF error 1042). Fall back to a
        // public fetch only if the binding isn't configured.
        let up;
        if (env.SKILL_SYSTEM) {
          up = await env.SKILL_SYSTEM.fetch(new Request('https://skill-system.internal/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
          }));
        } else {
          const skillBase = (env.SKILL_SYSTEM_URL || 'https://aria-skill-system.aadijha338.workers.dev').replace(/\/+$/, '');
          up = await fetch(skillBase + '/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
          });
        }
        if (!up.ok) {
          const detail = await up.text().catch(() => '');
          return cors(JSON.stringify({ error: `skill-system ${up.status}`, detail: detail.slice(0, 200) }), 502);
        }
        const data = await up.json();
        return cors(JSON.stringify({ reply: data.response ?? 'No response', skill: data.skill ?? 'general', model: data.model ?? null, modelId: data.modelId ?? null }), 200);
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 502);
      }
    }

    // Proxy /ruby/* and /aadi/* to agents-backend if configured
    if ((path.startsWith('/ruby/') || path.startsWith('/aadi/')) && env.AGENTS_BACKEND_URL) {
      try {
        const up = await fetch(env.AGENTS_BACKEND_URL + path + url.search, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: ['GET', 'HEAD'].includes(method) ? undefined : request.body,
        });
        const data = await up.text();
        return cors(data, up.status);
      } catch (e) {
        return cors(JSON.stringify({ error: e.message }), 502);
      }
    }

    // Default
    return cors(JSON.stringify({ status: 'ok', message: 'ARIA Backend OK' }), 200);
  },
};
