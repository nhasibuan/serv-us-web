# Code Review: serv-us-web

A brainstorm → plan → verify → review pass over the current state of the project.

> **TL;DR:** The `README.md` is an ambitious 4-phase product spec; the code is a single Phase-0 spike. The spike is well-factored (clean Strategy/Facade seams) but is **not loadable** — there is no `manifest.json`. Fastest high-value move is to make Phase 0 loadable, then go straight at the MAIN-world wa-js bridge in Phase 1.

---

## 1. Brainstorm — the AS-IS system

**What exists today vs. what the spec describes are two very different things.** The README is an ambitious 4-phase product spec; the code is a single Phase-0 spike.

### Code reality (Phase 0 only)

One file: `extension/serv-us.content.js` — an IIFE content script. No `manifest.json`, no build, no backend, no TypeScript.

The pipeline is cleanly factored behind Strategy/Facade seams:

| Seam | Phase-0 concrete | Designed swap-in |
|------|------------------|------------------|
| `MessageSource` | `DomIncomingMessageSource` (MutationObserver + DOM scrape) | `WppStoreMessageSource` (wa-js store hook) |
| `Translator` | `EchoTranslator` (returns `(en) text`) | `BackendTranslator` (already stubbed, calls `/translate`) |
| `OverlayRenderer` | DOM overlay under bubble | unchanged |
| `Semaphore` | bounded concurrency (4) | unchanged |
| `TranslationController` | wires it all in `bootstrap()` | unchanged |

**Genuinely good things already in place:**

- Content-hash (djb2) dedupe via `WeakMap` → edited messages re-translate instead of being skipped.
- Bounded concurrency so scroll-back loading 100 bubbles can't fan out 100 translate calls.
- Single composition root; concrete classes only known in `bootstrap()`.
- `BackendTranslator` is already written, so the Phase 1 translator swap is a one-line change.

**AS-IS gaps (vs. the spec's own architecture):**

- ❌ No `manifest.json` — the extension can't actually be loaded into Chrome.
- ❌ Capture is DOM scraping — the exact thing §3.2 says *not* to do in production.
- ❌ Incoming-only, read-only — no outgoing/draft path, no `WPP.chat.sendTextMessage`.
- ❌ No backend, no RAG, no WHAPI, no MAIN-world bridge.
- ❌ Repo structure (`extension/src/...`, `backend/`) from §5 doesn't exist; the file is `serv-us.content.js`, not under `src/`.

---

## 2. Plan — the TO-BE design

The spec's Phase roadmap *is* the to-be sequence. The useful design work is making the **next increment** concrete and pinning down the seams that protect against the unofficial dependencies.

**Immediate next step (finish Phase 0 → make it loadable):**

1. Add `extension/manifest.json` (MV3, `matches: *://web.whatsapp.com/*`, content script registration).
2. Keep `EchoTranslator` — goal is just "loads in Chrome, overlays appear."

**Then Phase 1 (two-way translation), the first real milestone:**

1. Stand up `backend/` (FastAPI async) with `POST /translate` (Tier-1 MT/LLM).
2. Flip `bootstrap()` to `BackendTranslator(url)`.
3. Add the **MAIN-world wa-js bridge** now (don't defer) — it replaces `DomIncomingMessageSource` with `WppStoreMessageSource` and unlocks reliable capture + `sendTextMessage`. This is the highest-leverage architectural move.
4. Draft translation + preview-before-send UI.

**Architectural guardrails to lock in before more dependencies pile up:**

- Wrap each unofficial dependency (wa-js, notebooklm-py, WHAPI) behind an interface — the code already does this for `Translator`/`MessageSource`; mirror it server-side for RAG and history.
- `chatId → {notebook_id, source_id}` store designed for **non-idempotent** `add_text` (delete-then-readd on refresh).
- RAG client pool = **one notebooklm client per event loop**, never shared across threads.

---

## 3. Verify — does the plan hold up against the code?

- ✅ **Translator swap is real** — `BackendTranslator` exists and matches the `{text, targetLang} → {translation}` contract; the Phase 1 backend just has to honor it.
- ✅ **Source swap is clean** — `MessageSource.start(onMessage)` is the only coupling point; `WppStoreMessageSource` can drop in without touching controller/renderer.
- ⚠️ **Renderer assumes DOM bubbles** — even with a store-hook source, you still need a DOM anchor to place the overlay. §3.2 acknowledges "a thin DOM layer is still used to render," but the *mapping from a store message → its bubble element* is unspecified and is the trickiest part of the wa-js migration. **This is the biggest unverified assumption.**
- ⚠️ **`id` stability** — Phase 0 derives ids from `data-id` or a random fallback; the store hook gives real message ids. Mixing the two across a migration could double-render. Worth unifying on the wa-js id early.
- ❌ **Manifest absence blocks everything** — nothing is loadable/demoable today, so even Phase 0's own acceptance criterion ("new incoming messages reliably produce a translated line") can't be exercised.

---

## 4. Review — risks, decisions, recommendation

**Top risks (mostly already named in §4, ranked by what bites you first):**

1. **No manifest** = zero working demo. Fastest, highest-value fix.
2. **DOM↔store bubble mapping** for overlay placement — the real engineering risk in the wa-js move; the spec hand-waves it.
3. **Stacked unofficial deps + WhatsApp ToS/ban risk** — make RAG ingestion opt-in per contact (spec agrees), keep WHAPI off the hot path.
4. **NotebookLM caps/rate limits + non-idempotent sources** — resolve the §8 "one notebook per contact vs. shared+scoped" question before Phase 3.

**Decisions needed from the product owner (the spec's open questions, prioritized):**

- Tier-1 provider for `/translate`? (Determines how fast Phase 1 ships.)
- Target language: fixed pair or auto-detect per contact?
- Notebook topology: per-contact vs. shared + `source_ids` (drives the whole store schema).

**Recommendation:** do the smallest thing that turns this from "spec + spike" into "running extension" — **add `manifest.json` so Phase 0 is actually loadable** — then go straight at the **MAIN-world wa-js bridge** in Phase 1, because every later phase rides on reliable capture/send and you want to retire the DOM-scrape source before building more on top of it.
