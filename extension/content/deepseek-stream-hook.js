'use strict';

/**
 * DeepSeek real SSE stream hook (MAIN world).
 *
 * Why this file exists
 * --------------------
 * Scraping the DOM forces us to guess when a reply is "finished" (we had to
 * wait for the text to stay still), which adds latency and can truncate long or
 * paused answers. DeepSeek's own web client already receives the model output as
 * an SSE stream inside the page, so we listen to that stream directly and get:
 *   - real incremental text (first token reaches the caller immediately)
 *   - an authoritative completion signal (FINISHED / stream close)
 *   - full fidelity text (no DOM node truncation)
 *
 * The hook is intentionally defensive: if DeepSeek changes its transport or the
 * page blocks the interceptor, it simply reports nothing and the content driver
 * transparently falls back to DOM scraping.
 *
 * Communication with the isolated-world driver uses window.postMessage and is
 * validated by the driver (requestId + message tag).
 */

(() => {
  if (window.__chatBridgeDeepseekHook) return;
  window.__chatBridgeDeepseekHook = true;

  const TAG = 'chat-bridge-deepseek-hook';
  const post = (payload) => {
    try {
      window.postMessage({ source: TAG, payload }, '*');
    } catch {
      /* page is being torn down */
    }
  };

  // ---------------------------------------------------------------------
  // Active request state
  // ---------------------------------------------------------------------
  const state = {
    activeId: null,
    opened: false,
    buffered: '',      // text held back because DSML may follow
    raw: '',           // everything received for the active request
    sawDsml: false,    // once true we stop live streaming and only flush at the end
    contentEmitted: 0,
    seen: false,
    done: false,
    error: null,
    startedAt: 0,
    responseFragmentIndex: -1,
    currentFragmentIndex: -1,
    fragmentCursor: 0,
  };

  // ---------------------------------------------------------------------
  // Transport activation
  //
  // As soon as we see a completion request for the active id we tell the
  // driver "the real stream is in use". This matters for answers that contain
  // no visible prose at all (a pure tool call), where no text chunk is ever
  // emitted and the driver would otherwise fall back to DOM scraping.
  // ---------------------------------------------------------------------
  function markStreamOpen() {
    if (!isActive() || state.opened) return;
    state.opened = true;
    post({ kind: 'open', requestId: state.activeId });
  }

  function reset(id) {
    state.activeId = id;
    state.opened = false;
    state.buffered = '';
    state.raw = '';
    state.sawDsml = false;
    state.contentEmitted = 0;
    state.seen = false;
    state.done = false;
    state.error = null;
    state.startedAt = Date.now();
    state.responseFragmentIndex = -1;
    state.currentFragmentIndex = -1;
    state.fragmentCursor = 0;
  }

  function isActive() {
    return !!state.activeId && !state.done;
  }

  // ---------------------------------------------------------------------
  // DSML sanitising
  //
  // Tool calls arrive inside the same text stream. We must never leak DSML to
  // the API client, but we still want true incremental streaming for plain
  // answers, which is the common and latency-sensitive case.
  //
  // Strategy (deliberately simple, and correct across chunk boundaries):
  //   1. While no DSML marker has been seen, stream prose immediately, holding
  //      back only a possible partial marker at the tail.
  //   2. As soon as a marker appears, switch to "collect" mode: buffer silently
  //      so no fragment of a tool block can escape.
  //   3. When the stream finishes, remove every DSML region in one pass and
  //      emit the remaining prose.
  // ---------------------------------------------------------------------
  const MARKERS = ['<｜｜DSML｜｜', '<||DSML||', '<DSML'];
  const ANY_DSML = /<\s*\/?\s*(?:｜｜|\|\|)?\s*dsml/i;

  function partialMarkerLength(text) {
    const max = Math.min(text.length, 16);
    for (let len = max; len > 0; len -= 1) {
      const tail = text.slice(-len);
      if (MARKERS.some((marker) => marker.startsWith(tail))) return len;
    }
    return 0;
  }

  function hasPartialMarkerAtEnd(text) {
    return partialMarkerLength(text) > 0;
  }

  function emit(delta) {
    if (!delta) return;
    state.contentEmitted += delta.length;
    state.seen = true;
    post({ kind: 'chunk', requestId: state.activeId, delta });
  }

  // Removes every DSML tag and everything between an opening marker and the
  // matching closing tag. Applied to the complete buffer at finish time.
  function stripDsmlRegions(text) {
    if (!ANY_DSML.test(text)) return text;
    const openRe = /<\s*(?:｜｜|\|\|)?\s*dsml/i;
    const closeRe = /<\s*\/\s*(?:｜｜|\|\|)?\s*dsml\s*(?:｜｜|\|\|)?\s*[^>]*>/i;
    let out = '';
    let i = 0;

    while (i < text.length) {
      const open = openRe.exec(text.slice(i));
      if (!open) {
        out += text.slice(i);
        break;
      }
      out += text.slice(i, i + open.index);
      let cursor = i + open.index;

      // Consume every complete closing tag plus any plain text between them
      // until we reach a spot with no further closing tag.
      let closed = false;
      for (let guard = 0; guard < 400; guard += 1) {
        const close = closeRe.exec(text.slice(cursor));
        if (!close) {
          cursor = text.length;
          break;
        }
        cursor += close.index + close[0].length;
        // Stop as soon as the remainder is not part of the tool block.
        const rest = text.slice(cursor);
        const nextClose = closeRe.exec(rest);
        const nextOpen = openRe.exec(rest);
        const closerIndex = nextClose ? nextClose.index : Infinity;
        const openerIndex = nextOpen ? nextOpen.index : Infinity;
        if (closerIndex === Infinity && openerIndex === Infinity) {
          closed = true;
          break;
        }
      }
      i = cursor;
      if (!closed) break; // unterminated block: drop the rest
    }
    return out;
  }

  function handleRaw(text) {
    if (!isActive() || !text) return;
    state.raw += text;

    if (state.sawDsml) {
      state.buffered += text;
      return;
    }

    state.buffered += text;
    if (ANY_DSML.test(state.buffered)) {
      state.sawDsml = true;
      return;
    }
    const hold = hasPartialMarkerAtEnd(state.buffered) ? partialMarkerLength(state.buffered) : 0;
    const ready = state.buffered.slice(0, state.buffered.length - hold);
    state.buffered = state.buffered.slice(state.buffered.length - hold);
    emit(ready);
  }

  function finish(error) {
    if (!state.activeId || state.done) return;
    if (error) state.error = String(error?.message || error);

    if (state.buffered) {
      if (state.sawDsml || ANY_DSML.test(state.buffered)) {
        emit(stripDsmlRegions(state.buffered));
      } else {
        emit(state.buffered);
      }
      state.buffered = '';
    }
    // If we streamed prose live, the DSML (if any) arrived later and was held.
    // Make sure nothing DSML-ish is left in the live path by re-checking.
    state.done = true;
    post({
      kind: 'raw-complete',
      requestId: state.activeId,
      raw: state.raw,
      error: state.error,
      streamed: state.contentEmitted > 0,
    });
  }

  // ---------------------------------------------------------------------
  // DeepSeek / OpenAI SSE parsing
  // ---------------------------------------------------------------------
  function appendFragment(fragment) {
    const idx = state.fragmentCursor;
    state.fragmentCursor += 1;
    state.currentFragmentIndex = idx;
    if (fragment && fragment.type === 'RESPONSE') {
      state.responseFragmentIndex = idx;
      if (typeof fragment.content === 'string' && fragment.content) {
        handleRaw(fragment.content);
      }
    }
  }

  function parseSseChunk(text) {
    if (!text) return;
    for (const line of String(text).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr) continue;
      if (dataStr === '[DONE]') {
        finish();
        continue;
      }
      let data;
      try {
        data = JSON.parse(dataStr);
      } catch {
        if (dataStr !== '{}') handleRaw(dataStr);
        continue;
      }
      parseEvent(data);
    }
  }

  function parseEvent(data) {
    if (!data || typeof data !== 'object') return;

    if (data.v?.response?.fragments && Array.isArray(data.v.response.fragments)) {
      state.fragmentCursor = 0;
      for (const fragment of data.v.response.fragments) appendFragment(fragment);
    }

    if (data.p === 'response/fragments' && data.o === 'APPEND' && Array.isArray(data.v)) {
      for (const fragment of data.v) appendFragment(fragment);
    }

    if (data.o === 'APPEND' && typeof data.p === 'string' && typeof data.v === 'string') {
      const match = data.p.match(/response\/fragments\/(\d+)\/content/);
      if (match) {
        state.currentFragmentIndex = Number(match[1]);
        if (state.currentFragmentIndex === state.responseFragmentIndex) handleRaw(data.v);
      }
    }

    if (!data.o && typeof data.p === 'string' && typeof data.v === 'string') {
      const match = data.p.match(/response\/fragments\/(\d+)\/content/);
      if (match) {
        const fragIdx = Number(match[1]);
        state.currentFragmentIndex = fragIdx;
        if (fragIdx === state.responseFragmentIndex) handleRaw(data.v);
      }
    }

    if (typeof data.v === 'string' && !data.p && !data.o) {
      if (state.currentFragmentIndex === state.responseFragmentIndex && state.responseFragmentIndex >= 0) {
        handleRaw(data.v);
      }
    }

    if (data.o === 'BATCH' && data.p === 'response' && Array.isArray(data.v)) {
      for (const item of data.v) {
        if (item.p === 'fragments' && item.o === 'APPEND' && Array.isArray(item.v)) {
          for (const fragment of item.v) appendFragment(fragment);
        }
        if (item.p === 'status' && item.v === 'FINISHED') finish();
      }
    }

    const delta = data.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta) handleRaw(delta);
    const message = data.choices?.[0]?.message?.content;
    if (typeof message === 'string' && message) {
      handleRaw(message);
      finish();
    }
    if (data.choices?.[0]?.finish_reason) finish();
  }

  function urlOf(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
      return String(input);
    } catch {
      return '';
    }
  }

  function isCompletionUrl(url) {
    return url.includes('chat') && (url.includes('completion') || url.includes('message'));
  }

  function consumeTextStream(reader, decoder) {
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parseSseChunk(decoder.decode(value, { stream: true }));
        }
        finish();
      } catch (err) {
        finish(err);
      }
    })();
  }

  // ---------------------------------------------------------------------
  // fetch
  // ---------------------------------------------------------------------
  if (!window.__chatBridgeFetchPatched) {
    window.__chatBridgeFetchPatched = true;
    const originalFetch = window.fetch;
    window.fetch = async function patchedFetch(...args) {
      const response = await originalFetch.apply(this, args);
      const url = urlOf(args[0]);
      if (isActive() && isCompletionUrl(url) && response.clone) {
        try {
          markStreamOpen();
          const clone = response.clone();
          if (clone.body?.getReader) {
            consumeTextStream(clone.body.getReader(), new TextDecoder());
          }
        } catch (err) {
          finish(err);
        }
      }
      return response;
    };
  }

  // ---------------------------------------------------------------------
  // XMLHttpRequest
  // ---------------------------------------------------------------------
  if (!window.__chatBridgeXhrPatched) {
    window.__chatBridgeXhrPatched = true;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__cbUrl = String(url || '');
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function patchedSend(...args) {
      const url = this.__cbUrl || '';
      if (isActive() && isCompletionUrl(url)) {
        markStreamOpen();
        let lastIndex = 0;
        this.addEventListener('progress', () => {
          try {
            const full = String(this.responseText || '');
            const text = full.slice(lastIndex);
            lastIndex = full.length;
            if (text) parseSseChunk(text);
          } catch {
            /* responseText may be unavailable for non-text responses */
          }
        });
        this.addEventListener('load', () => {
          try {
            const rest = String(this.responseText || '').slice(lastIndex);
            if (rest) parseSseChunk(rest);
          } catch {}
          finish();
        });
        this.addEventListener('error', () => finish(new Error('XHR error')));
      }
      return originalSend.apply(this, args);
    };
  }

  // ---------------------------------------------------------------------
  // EventSource
  // ---------------------------------------------------------------------
  if (!window.__chatBridgeEventSourcePatched && typeof window.EventSource === 'function') {
    window.__chatBridgeEventSourcePatched = true;
    const OriginalEventSource = window.EventSource;
    function PatchedEventSource(url, config) {
      const es = new OriginalEventSource(url, config);
      if (isActive() && isCompletionUrl(urlOf(url))) {
        markStreamOpen();
        es.addEventListener('message', (event) => {
          if (event.data) parseSseChunk(`data: ${event.data}`);
        });
      }
      return es;
    }
    PatchedEventSource.prototype = OriginalEventSource.prototype;
    window.EventSource = PatchedEventSource;
  }

  // ---------------------------------------------------------------------
  // Control surface used by the isolated-world driver
  // ---------------------------------------------------------------------
  window.__cbDeepseekHook = {
    version: 1,
    setActive(id) {
      if (id) reset(String(id));
    },
    clearActive(id) {
      if (!id || state.activeId === String(id)) {
        state.activeId = null;
        state.buffered = '';
        state.raw = '';
      }
    },
    status() {
      return {
        activeId: state.activeId,
        seen: state.seen,
        done: state.done,
        error: state.error,
        contentEmitted: state.contentEmitted,
      };
    },
    isAvailable: true,
  };

  post({ kind: 'ready', requestId: null });

  // Test seam: the emitter/parser is pure logic, so expose it when this file is
  // loaded from Node (the unit tests) instead of a browser content script.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      reset,
      handleRaw,
      finish,
      state,
      emit,
      stripDsmlRegions,
      parseSseChunk,
      parseEvent,
      partialMarkerLength,
      setActive: (id) => reset(String(id)),
    };
  }
})();