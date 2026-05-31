# serv-us-web

> A Chrome extension that adds **live, two-way translation** and **context-grounded reply suggestions** on top of WhatsApp Web — backed by a translation service and a Retrieval-Augmented Generation (RAG) layer.

This document is the technical specification and phased build plan. It is intentionally detailed so the architecture, design decisions, and constraints are locked before implementation.

---

## 1. Overview

`serv-us-web` augments the real `web.whatsapp.com` client in place. It does **not** rebuild WhatsApp. The extension:

1. **Translates both sides** of a conversation — incoming messages into the user's language, and the user's drafts into the recipient's language (with a preview before sending).
2. **Suggests N reply options** (configurable; default 3) that vary by tone (formal / casual / concise) and phrasing.
3. **Grounds those suggestions** in retrieved context — prior conversation history, a glossary/terminology doc, and reference material — via a RAG layer.

The valuable, defensible logic (translation + RAG) lives in a clean backend so it can be reused by a future standalone client (see Phase 4) without coupling to WhatsApp's DOM.

---

## 2. Architecture

```
[ WhatsApp Web tab ]
  └─ Extension (MV3)
       ├─ MAIN-world bridge   → hooks WhatsApp internal store (@wppconnect/wa-js)  ← capture + send
       └─ isolated content/UI → translation overlay + "Suggest" UI
            │  messages, draft context (HTTPS / WebSocket)
            ▼
[ Backend service (Python, async) ]
       ├─ /translate  → Tier-1 fast MT/LLM (inline, every message)
       ├─ /suggest    → Tier-2 grounded suggestions (notebooklm-py, on demand)
       └─ /ingest     → WHAPI history → RAG sources
            │
            ▼
[ RAG layer ]  notebooklm-py  (NotebookLM as a hosted, source-grounded RAG backend)
[ History    ]  WHAPI (optional)  GET /messages/list/{ChatID}  → backfill past conversation
```

### Components

| Component | Responsibility | Tech |
|-----------|----------------|------|
| **Extension — MAIN-world bridge** | Hook WhatsApp Web's internal message store; capture incoming/outgoing; send text | `@wppconnect/wa-js`, MV3 `world: "MAIN"` |
| **Extension — content/UI** | Render translation overlays under bubbles; draft preview; "Suggest" panel; talk to backend | TypeScript, MV3 content script (isolated world) |
| **Backend** | `/translate`, `/suggest`, `/ingest`; notebooklm-py client pool; `chatId → {notebook_id, source_id}` store | Python, async (FastAPI or similar) |
| **RAG layer** | Grounded suggestion generation with citations | [`notebooklm-py`](https://github.com/teng-lin/notebooklm-py) |
| **History ingestion (optional)** | Backfill a contact's past conversation to seed RAG | [WHAPI](https://whapi.cloud/docs) |

---

## 3. Key design decisions

### 3.1 Path A — augment the real client (not a clone)
Riding the official WhatsApp Web client ships the translation experience fastest and avoids rebuilding chat. The standalone-client path is deferred to Phase 4 and reuses the same backend.

### 3.2 Capture via internal-store hook (the MutationObserver alternative)
Instead of watching the DOM with `MutationObserver` (fragile, obfuscated, selector-churn), inject a **MAIN-world** script that hooks WhatsApp Web's internal store through `@wppconnect/wa-js`:
- **Receive:** subscribe to store events (e.g. `WPP.on('chat.new_message', cb)`) → structured `{ id, chatId, from, body, type, t }`.
- **Send:** `WPP.chat.sendTextMessage(chatId, text)` — robust, avoids the React `contenteditable` event-dispatch hacks.
- **Why not network interception:** WhatsApp's WebSocket is end-to-end encrypted (Noise protocol), so payloads are unreadable on the wire. Store-hooking is the only structured path.

A thin DOM layer is still used to render the translation overlay under each bubble.

### 3.3 Two-tier translation (latency-aware)
- **Tier 1 — inline, fast:** plain MT/LLM call for both-sides translation of each message and live draft preview. Sub-second; runs on every message.
- **Tier 2 — on-demand, grounded:** RAG suggestions via notebooklm-py, triggered by an explicit **"Suggest"** action (NOT per keystroke), then cached. NotebookLM `ask` responses take seconds and are rate-limited, so they are gated behind user intent.

### 3.4 RAG via notebooklm-py
NotebookLM is used as a hosted, source-grounded RAG backend:
- **Sources** = backfilled history + glossary/terminology + optional writing-style samples, added with `client.sources.add_text(...)`.
- **Persona** set once per notebook via `client.chat.configure(..., custom_prompt=...)` ("translation assistant; propose tone-varied options consistent with prior terminology; numbered list").
- **Suggestions** via `client.chat.ask(notebook_id, question, source_ids=None) -> AskResult` → `.answer` (parse N options), `.references` (citations `[N]` → `source_id`), `.conversation_id`.
- **Auth** = Google cookies in `storage_state.json` (`notebooklm login` once; `NOTEBOOKLM_AUTH_JSON` for containers); auto CSRF refresh; full cookie expiry requires re-login.

### 3.5 WHAPI is optional, and off the hot path
WHAPI is used only to **backfill history** so suggestions can be grounded in past conversation. Endpoint: **"Get messages by chat ID"** `GET /messages/list/{ChatID}` (paginated; confirm exact param names in the [reference](https://whapi.readme.io/reference/getmessagesbychatid)). This is a one-time/periodic batch job, keeping WHAPI's cost/ban risk off the interactive path.

---

## 4. Constraints & risks

These were validated against the upstream docs and shape the implementation:

1. **`sources.add_text` is NOT idempotent** — text sources have no server-side dedupe key, so retries/re-ingest create duplicates. Mitigation: maintain a `chatId → source_id` map; on refresh, `delete` then re-add (or append deltas).
2. **A single Google account shares rate limits and notebook/source caps** (`get_account_limits()`). One-notebook-per-contact can hit caps quickly. Mitigation: either a shared notebook scoped with `source_ids=`, or shard across **profiles** (multi-account).
3. **`NotebookLMClient` is async, per-event-loop, and NOT thread-safe.** Mitigation: backend worker pool with **one client per event loop**; never share across threads.
4. **Auth lifecycle.** Run `notebooklm login` once, persist `storage_state.json`, rely on auto CSRF refresh + keepalive; alert operators when a full re-login is required.
5. **Latency + throttling** (`with_rate_limit_retry`). Reinforces the Tier-1 / Tier-2 split.
6. **Stacked unofficial dependencies** — WhatsApp internals (wa-js) + NotebookLM internals (notebooklm-py) + WHAPI. Each can break independently and carries Terms-of-Service / stability risk. Isolate each behind an interface so it can be swapped (e.g. NotebookLM → self-hosted pgvector RAG; WHAPI → official WhatsApp Cloud API) without rewrites.

### Compliance & privacy
- Automating/augmenting WhatsApp may conflict with its Terms of Service and carries account-ban risk; WHAPI and notebooklm-py are unofficial. Evaluate before any production use.
- Message content flows through the backend, and (for Tier-2/RAG) through WHAPI and Google/NotebookLM. Be explicit with users; make RAG ingestion **opt-in per contact**.

---

## 5. Planned repository structure

```
serv-us-web/
├─ extension/            # MV3 Chrome extension
│  ├─ manifest.json
│  ├─ src/
│  │  ├─ main-world/     # wa-js bridge (world: "MAIN")
│  │  ├─ content/        # isolated content script + overlay UI
│  │  └─ background/     # service worker
│  └─ ...
├─ backend/              # Python async service
│  ├─ app/
│  │  ├─ routes/         # /translate, /suggest, /ingest
│  │  ├─ rag/            # notebooklm-py client pool + suggestion logic
│  │  ├─ ingest/         # WHAPI history → sources
│  │  └─ store/          # chatId → {notebook_id, source_id}
│  └─ ...
└─ README.md             # this spec
```

---

## 6. Phased roadmap

Each phase is independently demoable and builds on the previous one.

### Phase 0 — Spike (read-only)
Prove the hook works. Extension detects incoming bubbles and translates them only.
- **Deliverables:** MV3 manifest matching `*://web.whatsapp.com/*`; MAIN-world wa-js bridge capturing incoming messages as structured objects; inline overlay showing a (stub or real) translation under each incoming bubble.
- **Acceptance:** new incoming messages reliably produce a translated line beneath the original, with no DOM-selector scraping.

### Phase 1 — Two-way translation
Add outgoing drafts and a real backend.
- **Deliverables:** draft translation + preview; send via `WPP.chat.sendTextMessage`; backend `/translate` (Tier-1 MT/LLM); language detection per message to pick direction.
- **Acceptance:** user types in their language, sees a translated preview, confirms, and the translated text is sent; both directions render correctly.

### Phase 2 — Suggestions
Generate reply options without RAG yet.
- **Deliverables:** backend `/suggest` returning N tone/phrasing variants (fast LLM); "Suggest" UI in the composer; selecting a suggestion populates/sends it.
- **Acceptance:** clicking "Suggest" returns N (default 3) distinct, plausible reply options in the target language; latency acceptable for an on-demand action.

### Phase 3 — RAG
Ground suggestions in real context.
- **Deliverables:** notebooklm-py client pool; per-contact (or scoped) notebook; ingest glossary + conversation history as `add_text` sources; `/suggest` calls `chat.ask` and returns options with citations; `chatId → source_id` map with non-idempotent-safe refresh.
- **Acceptance:** suggestions respect prior terminology/tone and include source citations; ingestion refresh does not create duplicate sources.

### Phase 4 — WHAPI app (optional)
Standalone client reusing the same backend.
- **Deliverables:** optional headless/standalone client backfilling history via WHAPI `GET /messages/list/{ChatID}`; reuses `/translate`, `/suggest`, `/ingest`; `checkhealth` polling for connection status.
- **Acceptance:** history backfill seeds RAG; the standalone path produces the same grounded suggestions as the extension, with no backend changes.

---

## 7. Tech stack (proposed)

- **Extension:** TypeScript, Manifest V3, `@wppconnect/wa-js`, `MutationObserver` only for overlay placement.
- **Backend:** Python (async; FastAPI or equivalent) + WebSocket; an MT/LLM provider for Tier-1; `notebooklm-py` for Tier-2/RAG.
- **RAG/Embeddings (if self-hosting later):** pgvector or a hosted vector DB — kept behind an interface so notebooklm-py can be swapped out.

---

## 8. Open questions

1. **Notebook topology:** one notebook per contact, or one shared notebook scoped by `source_ids`? (Per-contact = better grounding but hits account caps faster.)
2. **Target language:** fixed pair, or auto-detected per contact?
3. **"N" suggestions:** fixed at 3 or user-configurable? Tone variants, literal variants, or both?
4. **RAG sources:** conversation history only, or also user-uploaded glossaries/reference docs?
5. **Official vs. unofficial:** acceptable risk level for WhatsApp ToS, WHAPI, and notebooklm-py in the target deployment?

---

## 9. Status

Specification stage. Phase 0 is the next implementation step. This README is the source of truth for scope and sequencing; update it as decisions are made.
