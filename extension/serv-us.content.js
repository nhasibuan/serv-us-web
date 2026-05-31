/**
 * serv-us-web — Phase 0 spike (read-only incoming translation)
 * =============================================================
 * Single-file WhatsApp Web content script. It detects *incoming* message
 * bubbles and renders a translated line beneath each one. Read-only: it never
 * sends, edits, or deletes anything. Goal: prove the capture -> translate ->
 * render pipeline works end to end.
 *
 * Design (kept deliberately swappable for later phases):
 *
 *   MessageSource (Strategy)        emits normalized Message objects
 *   Translator    (Strategy)        turns text into translated text
 *   OverlayRenderer (SRP)           draws the translation under a bubble
 *   Semaphore (utility)             bounds concurrent translation work
 *   TranslationController (Facade)  wires source -> queue -> translator -> renderer
 *
 * Everything is wired in one composition root (`bootstrap`) via dependency
 * injection, so Phase 1+ can swap a `WppStoreMessageSource` (wa-js store hook)
 * and a real `BackendTranslator` in without touching the controller, renderer,
 * or model. Phase 0 ships a zero-dependency DOM source and a stub translator
 * so the spike runs with no backend.
 *
 * Hardening applied:
 *   - Content-hash dedupe: bubbles are keyed by (stable id + content hash), so
 *     an *edited* message re-translates instead of being skipped forever.
 *   - Bounded concurrency: translations run through a semaphore, so a backlog
 *     (e.g. scrolling up to load 100 messages) cannot fan out 100 parallel
 *     translate calls.
 *
 * NOTE: The DOM selectors below are intentionally centralized in CONFIG. They
 * are brittle (WhatsApp Web obfuscates and changes its DOM) and exist only for
 * this spike — production capture uses the internal store hook, not scraping.
 */
(() => {
  "use strict";

  // ── Configuration (no magic strings/numbers scattered in logic) ──────────
  const CONFIG = Object.freeze({
    appRootSelector: "#app",
    incomingMessageSelector: "div.message-in",
    messageTextSelector: "span.selectable-text, span.copyable-text",
    processedMarker: "data-servus-translated",
    overlayClass: "servus-translation",
    observeDebounceMs: 150,
    maxConcurrentTranslations: 4,
    targetLanguage: "en",
    logPrefix: "[serv-us]",
  });

  /** @typedef {{ id: string, text: string, element: HTMLElement }} Message */

  // ── Concurrency primitive ────────────────────────────────────────────────
  /**
   * Counting semaphore with direct hand-off (permits are passed straight to
   * the next waiter on release, so the pool can never be over-subscribed).
   */
  class Semaphore {
    /** @param {number} permits */
    constructor(permits) {
      this._permits = permits;
      /** @type {Array<() => void>} */
      this._waiters = [];
    }

    async _acquire() {
      if (this._permits > 0) {
        this._permits--;
        return;
      }
      await new Promise((resolve) => this._waiters.push(resolve));
      // Permit was handed off directly by release(); do not decrement here.
    }

    _release() {
      const next = this._waiters.shift();
      if (next) next(); // hand the permit to the next waiter
      else this._permits++; // no waiter: return it to the pool
    }

    /**
     * Run `task` once a permit is available; always releases the permit.
     * @template T
     * @param {() => Promise<T>} task
     * @returns {Promise<T>}
     */
    async run(task) {
      await this._acquire();
      try {
        return await task();
      } finally {
        this._release();
      }
    }
  }

  // ── Translator strategies (depend on this abstraction, not a concretion) ──
  class Translator {
    /**
     * @param {string} _text
     * @param {string} _targetLang
     * @returns {Promise<string>}
     */
    async translate(_text, _targetLang) {
      throw new Error("Translator.translate() must be implemented");
    }
  }

  /** Phase 0 stub: no backend, proves the pipeline. Clearly marked output. */
  class EchoTranslator extends Translator {
    async translate(text, targetLang) {
      return `(${targetLang}) ${text}`;
    }
  }

  /** Phase 1 swap-in: delegates to the backend translation service. */
  class BackendTranslator extends Translator {
    /** @param {string} endpoint */
    constructor(endpoint) {
      super();
      this._endpoint = endpoint;
    }

    async translate(text, targetLang) {
      const res = await fetch(this._endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, targetLang }),
      });
      if (!res.ok) throw new Error(`translate failed: HTTP ${res.status}`);
      const { translation } = await res.json();
      return translation;
    }
  }

  // ── Message sources (Strategy) ───────────────────────────────────────────
  class MessageSource {
    /** @param {(msg: Message) => void} _onMessage */
    start(_onMessage) {
      throw new Error("MessageSource.start() must be implemented");
    }
    stop() {}
  }

  /**
   * DOM-based source for the Phase 0 spike. Observes the chat for incoming
   * bubbles and normalizes them into `Message` objects. A `WeakMap` keyed by
   * bubble element stores `{ id, hash }`, making emission idempotent for
   * unchanged text while re-emitting when a message's content changes (edit).
   */
  class DomIncomingMessageSource extends MessageSource {
    /** @param {typeof CONFIG} config */
    constructor(config) {
      super();
      this._config = config;
      this._observer = null;
      /** @type {WeakMap<Element, { id: string, hash: string }>} */
      this._state = new WeakMap();
      this._scanTimer = 0;
      this._onMessage = () => {};
    }

    start(onMessage) {
      this._onMessage = onMessage;
      const root =
        document.querySelector(this._config.appRootSelector) || document.body;
      this._observer = new MutationObserver(() => this._scheduleScan());
      this._observer.observe(root, { childList: true, subtree: true });
      this._scan(); // capture messages already on screen
    }

    stop() {
      this._observer?.disconnect();
      this._observer = null;
      if (this._scanTimer) clearTimeout(this._scanTimer);
      this._scanTimer = 0;
    }

    /** Coalesce bursts of mutations into a single scan. */
    _scheduleScan() {
      if (this._scanTimer) return;
      this._scanTimer = setTimeout(() => {
        this._scanTimer = 0;
        this._scan();
      }, this._config.observeDebounceMs);
    }

    _scan() {
      const bubbles = document.querySelectorAll(
        this._config.incomingMessageSelector
      );
      bubbles.forEach((bubble) => this._handleBubble(bubble));
    }

    /** @param {Element} bubble */
    _handleBubble(bubble) {
      const textEl = bubble.querySelector(this._config.messageTextSelector);
      const text = textEl?.textContent?.trim();
      if (!text) return; // skip media / system bubbles with no text

      const hash = this._hash(text);
      const prev = this._state.get(bubble);
      if (prev && prev.hash === hash) return; // unchanged → already handled

      const id = prev?.id ?? this._deriveId(bubble); // stable across edits
      this._state.set(bubble, { id, hash });
      this._onMessage({ id, text, element: /** @type {HTMLElement} */ (bubble) });
    }

    /**
     * Stable identifier for a bubble: prefer WhatsApp's own message id, fall
     * back to a generated one (kept across re-emissions via the WeakMap).
     * @param {Element} bubble
     * @returns {string}
     */
    _deriveId(bubble) {
      return (
        bubble.getAttribute("data-id") ||
        `servus-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
    }

    /**
     * Fast, non-cryptographic content hash (djb2) for change detection only.
     * @param {string} text
     * @returns {string}
     */
    _hash(text) {
      let h = 5381;
      for (let i = 0; i < text.length; i++) {
        h = ((h << 5) + h + text.charCodeAt(i)) | 0;
      }
      return (h >>> 0).toString(36);
    }
  }

  // ── Rendering (single responsibility: only touches the overlay node) ──────
  class OverlayRenderer {
    /** @param {typeof CONFIG} config */
    constructor(config) {
      this._config = config;
    }

    /** @param {Message} message */
    showPending(message) {
      const node = this._ensureNode(message.element);
      if (node) node.textContent = "…";
    }

    /**
     * @param {Message} message
     * @param {string} translation
     */
    showTranslation(message, translation) {
      const node = this._ensureNode(message.element);
      if (node) node.textContent = translation;
    }

    /** @param {Message} message */
    showError(message) {
      const node = this._ensureNode(message.element);
      if (node) node.textContent = "\u26A0 translation unavailable";
    }

    /**
     * Create (once) or fetch the overlay element for a bubble. The
     * `processedMarker` attribute guarantees a single overlay per bubble, so
     * re-translation (after an edit) updates the existing node in place.
     * @param {HTMLElement} bubble
     * @returns {HTMLElement | null}
     */
    _ensureNode(bubble) {
      if (bubble.getAttribute(this._config.processedMarker)) {
        return bubble.querySelector(`.${this._config.overlayClass}`);
      }
      const node = document.createElement("div");
      node.className = this._config.overlayClass;
      node.setAttribute("dir", "auto"); // correct RTL/LTR for the target lang
      Object.assign(node.style, {
        marginTop: "4px",
        fontSize: "0.85em",
        opacity: "0.75",
        fontStyle: "italic",
      });
      bubble.setAttribute(this._config.processedMarker, "1");
      bubble.appendChild(node);
      return node;
    }
  }

  // ── Controller / Facade (orchestrates; depends only on abstractions) ──────
  class TranslationController {
    /**
     * @param {{
     *   source: MessageSource,
     *   translator: Translator,
     *   renderer: OverlayRenderer,
     *   limiter: Semaphore,
     *   targetLanguage: string,
     * }} deps
     */
    constructor({ source, translator, renderer, limiter, targetLanguage }) {
      this._source = source;
      this._translator = translator;
      this._renderer = renderer;
      this._limiter = limiter;
      this._targetLanguage = targetLanguage;
    }

    start() {
      this._source.start((message) => this._enqueue(message));
    }

    stop() {
      this._source.stop();
    }

    /**
     * Show feedback immediately, then run the (rate-limited) translation.
     * @param {Message} message
     */
    _enqueue(message) {
      this._renderer.showPending(message);
      void this._limiter.run(() => this._translateAndRender(message));
    }

    /** @param {Message} message */
    async _translateAndRender(message) {
      try {
        const translation = await this._translator.translate(
          message.text,
          this._targetLanguage
        );
        this._renderer.showTranslation(message, translation);
      } catch (err) {
        console.error(`${CONFIG.logPrefix} translation failed`, err);
        this._renderer.showError(message);
      }
    }
  }

  // ── Composition root (the only place that knows concrete classes) ─────────
  function bootstrap() {
    const controller = new TranslationController({
      source: new DomIncomingMessageSource(CONFIG),
      translator: new EchoTranslator(), // Phase 1: new BackendTranslator(url)
      renderer: new OverlayRenderer(CONFIG),
      limiter: new Semaphore(CONFIG.maxConcurrentTranslations),
      targetLanguage: CONFIG.targetLanguage,
    });
    controller.start();
    console.info(
      `${CONFIG.logPrefix} Phase 0 spike active (read-only incoming translation)`
    );
  }

  bootstrap();
})();
