'use strict';

/* global chrome */

/**
 * DeepSeek DOM driver.
 *
 * This version intentionally does not depend on the private fetch/XHR
 * response shape. It uses the visible assistant message element, which is
 * more stable for the requested workflow: send text in a selected chat URL
 * and read the newly-created assistant reply from the page.
 */

(() => {
  if (window.__chatBridgeDriver) return;
  window.__chatBridgeDriver = true;

  if (location.hostname.toLowerCase() !== 'chat.deepseek.com') return;

  const domResponse = window.ChatBridgeDomResponse;
  const dsmlParser = window.ChatBridgeDsmlParser;
  if (!domResponse) {
    console.error('[chat-bridge-deepseek] dom-response.js در دسترس نیست');
    return;
  }
  if (!dsmlParser) {
    console.error('[chat-bridge-deepseek] dsml-parser.js در دسترس نیست');
  }

  const CONFIG = {
    inputSelector: 'textarea[placeholder="Message DeepSeek"]',
    responseSelector: '.ds-markdown.ds-assistant-message-main-content',
    pollInterval: 200,
    maxWait: 180_000,
    minStableTime: 2_000,
    minStableTimeWithIndicator: 5_000,
    continueWaitMs: 8_000,
    hookGraceMs: 4_000,
  };

  const activeOperations = new Map();
  const cancelledRequestIds = new Set();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------------------------------------------------------------------
  // Real SSE stream bridge (MAIN world hook)
  //
  // The hook runs in the page's MAIN world via manifest world:MAIN and posts
  // events here. We forward text immediately so the caller receives genuine
  // streaming, and we use the hook's completion signal instead of guessing
  // "the text stopped moving". If the hook is unavailable or DeepSeek changed
  // its transport, we transparently fall back to DOM scraping.
  // ---------------------------------------------------------------------
  const hookBus = { ready: false, requestId: null, content: '', raw: '', opened: false, seen: false, done: false, error: null };

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'chat-bridge-deepseek-hook' || !data.payload) return;
    const payload = data.payload;
    if (payload.kind === 'ready') {
      hookBus.ready = true;
      return;
    }
    if (payload.requestId && hookBus.requestId && payload.requestId !== hookBus.requestId) return;
    if (payload.kind === 'open') {
      // The real SSE transport took over, even if this answer has no prose.
      hookBus.opened = true;
      hookBus.seen = true;
      return;
    }
    if (payload.kind === 'chunk') {
      hookBus.seen = true;
      hookBus.content += payload.delta || '';
      try {
        chrome.runtime.sendMessage({
          type: 'hook-delta',
          requestId: hookBus.requestId,
          delta: payload.delta || '',
        });
      } catch {}
      return;
    }
    if (payload.kind === 'raw-complete') {
      hookBus.done = true;
      hookBus.raw = payload.raw || hookBus.content;
      hookBus.error = payload.error || null;
    }
  });

  function armHook(requestId) {
    hookBus.requestId = requestId;
    hookBus.content = '';
    hookBus.raw = '';
    hookBus.opened = false;
    hookBus.seen = false;
    hookBus.done = false;
    hookBus.error = null;
    try {
      window.__cbDeepseekHook?.setActive(requestId);
    } catch {}
  }

  function clearHook() {
    const id = hookBus.requestId;
    try {
      window.__cbDeepseekHook?.clearActive(id);
    } catch {}
    hookBus.requestId = null;
  }

  async function waitForHookOrDom(before, beforeSnapshot, signal, requestId, promptText, startedAt) {
    const deadline = startedAt + CONFIG.maxWait;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      if (Date.now() - lastHeartbeatTime >= 15_000) {
        lastHeartbeatTime = Date.now();
        try { chrome.runtime.sendMessage({ type: 'driver-heartbeat', requestId }); } catch {}
      }

      if (hookBus.seen) {
        if (hookBus.done) {
          if (hookBus.error) throw new Error(hookBus.error);
          timing('hook_stream_complete', startedAt);
          return { answer: hookBus.raw || hookBus.content, streamed: true };
        }
        await sleep(CONFIG.pollInterval);
        continue;
      }

      if (Date.now() - startedAt >= CONFIG.hookGraceMs) {
        logToBackground('[timing] hook_grace_expired → fallback to DOM');
        const answer = await waitForNewResponse(before, beforeSnapshot, signal, requestId, promptText);
        return { answer, streamed: false };
      }

      await sleep(CONFIG.pollInterval);
    }
    throw new Error('تایم‌اوت: نه استریم واقعی و نه پاسخ DOM دریافت نشد.');
  }

  function isAbortError() {
    const error = new Error('درخواست لغو شد');
    error.code = 'ABORT_ERR';
    return error;
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw isAbortError();
  }

  async function waitFor(fn, { timeout = 15_000, interval = 100, signal } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      throwIfAborted(signal);
      try {
        const value = fn();
        if (value) return value;
      } catch (err) {
        if (err?.code === 'ABORT_ERR') throw err;
      }
      await sleep(interval);
    }
    return null;
  }

  function inputIsUsable(element) {
    if (!element || isDisabled(element)) return false;
    if (typeof element.getClientRects === 'function' && element.getClientRects().length > 0) return true;
    return element.offsetParent !== null;
  }

  function findInput() {
    const selectors = [
      CONFIG.inputSelector,
      'textarea[name="search"]',
      'textarea[placeholder]',
      'textarea',
      'input[type="text"]',
      '[contenteditable="true"]',
    ];
    const candidates = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!candidates.includes(element)) candidates.push(element);
      }
    }
    const usable = candidates.filter(inputIsUsable);
    const exact = usable.find((element) => element.matches?.(CONFIG.inputSelector));
    if (exact) return exact;
    const named = usable.find((element) => /message|deepseek|chat|prompt|ask/i.test(element.placeholder || ''));
    if (named) return named;
    return usable.find((element) => element.tagName === 'TEXTAREA' || element.isContentEditable) || usable[0] || null;
  }

  function isDisabled(element) {
    if (!element) return true;
    if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') return true;
    return /disabled|loading/i.test(String(element.className || ''));
  }

  function findSendButton() {
    const elements = [...document.querySelectorAll('div[role="button"], button')];
    return elements.find((element) => {
      const className = String(element.className || '');
      if (!className.includes('ds-button--primary')) return false;
      if (!className.includes('ds-button--circle')) return false;
      if (!className.includes('ds-button--filled')) return false;
      if (isDisabled(element) || !inputIsUsable(element)) return false;
      if (element.querySelector('input[type="file"]')) return false;
      if (element.parentElement?.querySelector('input[type="file"]')) return false;
      return true;
    }) || null;
  }

  function hasActiveGenerationIndicator() {
    const elements = [...document.querySelectorAll('div[role="button"], button, [aria-busy="true"]')];
    return elements.some((element) => {
      if (element.getAttribute('aria-busy') === 'true') return true;
      const text = String(element.innerText || element.textContent || '').trim().toLowerCase();
      const label = String(element.getAttribute('aria-label') || '').trim().toLowerCase();
      if (/^(stop|stop generating|stop generation|توقف|در حال تولید)$/.test(text)) return true;
      if (/^(stop|stop generating|stop generation|توقف|در حال تولید)$/.test(label)) return true;
      return element.matches?.('.ds-loading, [class*="loading-spinner"], [class*="loading-circle"]');
    });
  }

  function timing(stage, startedAt) {
    logToBackground(`[timing] ${stage} ${Date.now() - startedAt}ms`);
  }

  function findContinueButton() {
    const elements = [...document.querySelectorAll('div[role="button"], button, [aria-label]')];
    return elements.filter((element) => {
      if (!inputIsUsable(element) || isDisabled(element)) return false;
      const text = String(element.innerText || element.textContent || '').trim().toLowerCase();
      const label = String(element.getAttribute('aria-label') || '').trim().toLowerCase();
      return text === 'continue'
        || text === 'ادامه'
        || label === 'continue'
        || label === 'ادامه';
    }).pop() || null;
  }

  async function resumeInterruptedResponse(signal) {
    const button = findContinueButton();
    if (!button) return false;
    const startedAt = Date.now();
    logToBackground('دکمهٔ Continue پیدا شد؛ ادامهٔ پاسخ قبلی فعال می‌شود.');
    button.click();
    const deadline = startedAt + CONFIG.continueWaitMs;
    let lastHeartbeat = 0;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      if (!findContinueButton()) {
        timing('continue_resume', startedAt);
        return true;
      }
      if (Date.now() - lastHeartbeat >= 15_000) {
        lastHeartbeat = Date.now();
        try { chrome.runtime.sendMessage({ type: 'driver-heartbeat' }); } catch {}
      }
      await sleep(CONFIG.pollInterval);
    }
    logToBackground('دکمهٔ Continue باقی ماند؛ ادامه با ارسال prompt انجام می‌شود.');
    timing('continue_timeout', startedAt);
    return true;
  }

  function inputTextOf(element) {
    if (!element) return '';
    if (element.isContentEditable) return String(element.innerText || element.textContent || '');
    return String(element.value ?? '');
  }

  function normalizeInputText(value) {
    return String(value || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  }

  function inputContainsText(element, expected) {
    const actual = normalizeInputText(inputTextOf(element));
    const wanted = normalizeInputText(expected);
    if (!actual || !wanted) return false;
    if (actual === wanted || actual.includes(wanted)) return true;
    const probe = wanted.slice(0, Math.min(120, wanted.length));
    return probe.length > 0 && actual.includes(probe);
  }

  function setInputValue(element, value) {
    if (!element) return;
    element.focus();
    if (element.isContentEditable) {
      try { document.execCommand('selectAll', false); } catch {}
      try { document.execCommand('insertText', false, value); } catch {}
      if (!inputTextOf(element)) element.textContent = value;
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: value,
        inputType: 'insertText',
      }));
      return;
    }
    const proto = element.tagName === 'INPUT'
      ? window.HTMLInputElement.prototype
      : window.HTMLTextAreaElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function primeInput(text, signal) {
    const startedAt = Date.now();
    let lastInput = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      throwIfAborted(signal);
      const input = await waitFor(findInput, { timeout: 4_000, interval: 100, signal });
      if (!input) continue;
      lastInput = input;
      setInputValue(input, '');
      await sleep(120);
      throwIfAborted(signal);
      setInputValue(input, text);
      await sleep(500);
      if (inputContainsText(input, text)) {
        timing('input_ready', startedAt);
        return input;
      }
      // A React re-render can discard the native setter; retry with a fresh node.
      await sleep(200);
    }
    const actual = lastInput ? inputTextOf(lastInput).slice(0, 200) : '';
    timing('input_failed', startedAt);
    throw new Error(`متن در باکس ورودی ثبت نشد. tag=${lastInput?.tagName || 'none'} current=${actual}`);
  }

  function pressEnter(element) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      element.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }));
    }
  }

  function responseNodes() {
    const selector = [
      CONFIG.responseSelector,
      '.ds-markdown',
      '[class*="ds-markdown"]',
      '[class*="assistant-message"]',
      '[data-message-author-role="assistant"]',
    ].join(', ');
    const visible = [...document.querySelectorAll(selector)].filter((element) => {
      if (element.getClientRects?.().length) return true;
      return element.offsetParent !== null;
    });
    // Keep the deepest matching node when a fallback selector is nested
    // inside the primary assistant response element.
    return visible.filter((element) => !visible.some(
      (other) => other !== element && element.contains(other),
    ));
  }

  function responseState() {
    const nodes = responseNodes();
    const last = nodes[nodes.length - 1] || null;
    return {
      count: nodes.length,
      text: (last?.innerText || '').trim(),
      node: last,
    };
  }

  function isVisible(element) {
    return !!(element.getClientRects?.().length || element.offsetParent !== null);
  }

  function collectDebugDom() {
    let hook = null;
    try {
      hook = window.__cbDeepseekHook
        ? window.__cbDeepseekHook.status()
        : { available: false };
    } catch {}
    const selectors = [
      CONFIG.responseSelector,
      '[class*="ds-markdown"]',
      '[class*="assistant-message"]',
      '[class*="assistant"]',
      '[data-message-author-role="assistant"]',
      '[class*="markdown"]',
      '[class*="message"]',
    ];
    return {
      url: location.href,
      hook,
      input: {
        found: !!findInput(),
        placeholder: findInput()?.placeholder || null,
      },
      selectors: selectors.map((selector) => {
        const nodes = [...document.querySelectorAll(selector)];
        return {
          selector,
          count: nodes.length,
          visible: nodes.filter(isVisible).length,
          samples: nodes.filter(isVisible).slice(-3).map((node) => ({
            tag: node.tagName,
            className: String(node.className || '').slice(0, 160),
            text: (node.innerText || '').trim().slice(0, 240),
          })),
        };
      }),
    };
  }

  async function waitForNewResponse(before, beforeSnapshot, signal, requestId, promptText) {
    const start = Date.now();
    let lastText = '';
    let lastChange = start;
    let lastHeartbeat = 0;
    let firstResponseLogged = false;
    let userNode = null;

    while (Date.now() - start < CONFIG.maxWait) {
      if (requestId && Date.now() - lastHeartbeat >= 15_000) {
        lastHeartbeat = Date.now();
        try { chrome.runtime.sendMessage({ type: 'driver-heartbeat', requestId }); } catch {}
      }
      throwIfAborted(signal);

      const generic = domResponse.findGenericResponse(document, promptText, userNode);
      if (generic?.userNode) userNode = generic.userNode;
      const changed = !generic && Date.now() - start >= 8_000
        ? domResponse.findChangedResponse(document, beforeSnapshot, promptText)
        : null;
      const current = generic
        ? { count: before.count + 1, text: generic.text }
        : changed
          ? { count: before.count + 1, text: changed.text }
          : responseState();
      const isNew = generic
        ? generic.text !== promptText
        : changed
          ? true
          : !before
            || current.count > before.count
            || (current.count === before.count && current.text !== before.text);

      if (!isNew || !current.text) {
        await sleep(CONFIG.pollInterval);
        continue;
      }

      if (current.text !== lastText) {
        lastText = current.text;
        lastChange = Date.now();
        if (!firstResponseLogged) {
          firstResponseLogged = true;
          timing('first_response', start);
        }
        await sleep(CONFIG.pollInterval);
        continue;
      }

      const generating = hasActiveGenerationIndicator() || !!findContinueButton();
      const requiredStable = generating ? CONFIG.minStableTimeWithIndicator : CONFIG.minStableTime;
      if (Date.now() - lastChange >= requiredStable) {
        timing('response_stable', start);
        return lastText.trim();
      }
      await sleep(CONFIG.pollInterval);
    }

    if (lastText.trim()) {
      timing('response_unstable_timeout', start);
      throw new Error('پاسخ در زمان مجاز پایدار نشد؛ ممکن است تولید DeepSeek متوقف شده باشد.');
    }
    const debug = collectDebugDom();
    const summary = debug.selectors.map((entry) => `${entry.selector}=${entry.visible}/${entry.count}`).join(', ');
    logToBackground(`تشخیص پاسخ ناموفق بود؛ ${summary}`);
    timing('response_not_found', start);
    throw new Error(`تایم‌اوت: پاسخ جدیدی از DeepSeek ظاهر نشد. (${summary})`);
  }

  function collectHistory() {
    const selectors = [
      '[data-message-author-role="user"]',
      '[class*="user-message"]',
      CONFIG.responseSelector,
    ];
    const nodes = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
    const seen = new Set();
    const history = [];
    for (const node of nodes) {
      if (!node.getClientRects?.().length && node.offsetParent === null) continue;
      const text = (node.innerText || '').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
    }
    return history;
  }

  function isRateLimited() {
    const text = (document.body?.innerText || '').slice(-3000);
    return /rate limit|too many requests|requests too frequent|تموم شده|بسیار زیاد|محدودیت|لیمیت/i.test(text);
  }

  function showStatus(text) {
    let element = document.getElementById('__chat_bridge_deepseek_status');
    if (!element) {
      element = document.createElement('div');
      element.id = '__chat_bridge_deepseek_status';
      element.style.cssText = [
        'position:fixed', 'bottom:12px', 'right:12px', 'z-index:2147483647',
        'background:#0b1020', 'color:#7dd3fc', 'font:12px/1.4 monospace',
        'padding:6px 10px', 'border-radius:8px', 'border:1px solid #1e3a8a',
        'pointer-events:none', 'max-width:320px',
      ].join(';');
      document.documentElement.appendChild(element);
    }
    element.textContent = `🌉 ${text}`;
  }

  function logToBackground(message) {
    try { chrome.runtime.sendMessage({ type: 'log', text: `[driver] ${message}` }); } catch {}
  }

  async function sendAndCollect({ text, requestId, signal }) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('متن پیام خالی است.');
    const startedAt = Date.now();
    await resumeInterruptedResponse(signal);
    const before = responseState();
    const beforeSnapshot = domResponse.snapshot(document);
    armHook(requestId);
    try {
      const input = await primeInput(text, signal);
      if (!input) throw new Error('باکس ورودی DeepSeek پیدا نشد؛ ابتدا وارد حساب شوید.');

      const button = waitFor(findSendButton, { timeout: 8_000, interval: 100, signal });
      const resolvedButton = await button;
      throwIfAborted(signal);
      if (resolvedButton) resolvedButton.click();
      else pressEnter(input);
      timing('send_clicked', startedAt);
      await sleep(500);
      throwIfAborted(signal);
      if (inputContainsText(input, text)) {
        pressEnter(input);
        timing('send_enter_fallback', startedAt);
      }

      logToBackground('پیام ارسال شد؛ در انتظار پاسخ DeepSeek...');
      const result = await waitForHookOrDom(before, beforeSnapshot, signal, requestId, text, startedAt);
      timing('response_collected', startedAt);
      return result;
    } finally {
      clearHook();
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      try {
        switch (message.type) {
          case 'ping':
            sendResponse({ ok: true, site: 'deepseek', hasInput: !!findInput() });
            return;
          case 'send-and-collect': {
            const requestId = message.requestId || `local-${Date.now()}`;
            if (cancelledRequestIds.has(requestId)) {
              cancelledRequestIds.delete(requestId);
              sendResponse({ ok: false, cancelled: true, error: 'cancelled' });
              return;
            }
            const controller = new AbortController();
            activeOperations.set(requestId, controller);
            showStatus('در حال ارسال پیام...');
            try {
              const result = await sendAndCollect({
                text: message.text,
                requestId,
                signal: controller.signal,
              });
              const answer = typeof result === 'string' ? result : result.answer;
              const streamed = typeof result === 'string' ? false : result.streamed;
              const parsed = dsmlParser?.parseToolCalls(answer) || {
                text: answer,
                toolCalls: [],
                hasToolCalls: false,
              };
              showStatus(parsed.toolCalls.length > 0 ? 'tool call آماده شد ✓' : 'پاسخ کامل دریافت شد ✓');
              sendResponse({
                ok: true,
                answer: parsed.text || '',
                rawAnswer: answer || '',
                toolCalls: parsed.toolCalls || [],
                streamed,
              });
            } catch (err) {
              const cancelled = err?.code === 'ABORT_ERR';
              sendResponse({ ok: false, cancelled, error: cancelled ? 'cancelled' : err.message });
            } finally {
              activeOperations.delete(requestId);
            }
            return;
          }
          case 'cancel': {
            if (message.requestId) {
              cancelledRequestIds.add(message.requestId);
              activeOperations.get(message.requestId)?.abort();
              setTimeout(() => cancelledRequestIds.delete(message.requestId), 30_000);
            }
            sendResponse({ ok: true });
            return;
          }
          case 'debug-dom':
            sendResponse({ ok: true, debug: collectDebugDom() });
            return;
          case 'get-history':
            sendResponse({ ok: true, history: collectHistory() });
            return;
          case 'check-rate-limit':
            sendResponse({ ok: true, rateLimited: isRateLimited() });
            return;
          default:
            sendResponse({ ok: false, error: 'unknown message type' });
        }
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  });

  showStatus('آماده ✓');
})();
