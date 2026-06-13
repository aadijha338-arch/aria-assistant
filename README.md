# aria-assistant

Cloudflare Worker backend for ARIA. Runs entirely on **Gemini + DeepSeek** — no Anthropic/Claude dependency.

## Models
- `/claude` — default chat endpoint (name kept for frontend compatibility). Routes to Gemini (with Google Search grounding + image/vision passthrough) → DeepSeek fallback. Returns Anthropic-shaped JSON.
- `/gemini` — Gemini with Google Search grounding → DeepSeek fallback.
- `/analyze` — native zero-LLM language analysis (intent / entities / sentiment / urgency), ported from `aria-neural`. Free, no model call.

Web search is enabled automatically when a request carries a `web_search` tool or the native classifier detects a time-sensitive query (news, prices, "today", etc.), unless the turn includes an image.

## Graph memory (Vectorize)
Memory is an associative graph, not flat top-K search (ported from `aria-neural`, runs on the existing Vectorize index — no extra storage).
- `POST /memory/store` — embeds the text, stores it as a node, and auto-links it to the most similar existing memories with weighted edges.
- `POST /memory/search` — semantic seeds **+ spreading activation** across edges, so memories linked to a match surface too. Returns `[{ summary, ts, score, via }]` (`via` = `semantic` | `associative`). Co-activated results are reinforced (hebbian). Node strength decays lazily by last-access time.
- `POST /memory/connect` — manually link two nodes `{ aId, bId, type?, weight? }`.
- `GET /memory/node?id=` — inspect a node's metadata, effective strength, and edges.

## Other endpoints
`/files/*` (R2), `/gmail/*` (OAuth + send/read), `/api/crypto`, `/ruby/status`, `/aadi/chat` (skill-system).

## Env / secrets
`GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `CF_ACCOUNT_ID`, `CF_AI_TOKEN`, `GMAIL_CLIENT_ID/SECRET`, `SKILL_UPDATE_TOKEN`. `CLAUDE_API_KEY` is no longer used and can be removed.
