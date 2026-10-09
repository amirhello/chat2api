'use strict';

/* global chrome, WebSocket */

/**
 * Chat Bridge DeepSeek background service worker.
 *
 * The bridge can receive an explicit DeepSeek conversation URL for every
 * request. If no URL is supplied, an already-open normal DeepSeek tab is
 * preferred and a new tab is opened only when necessary.
 */

const BRIDGE_HTTP_URL = 'http://127.0.0.1:20258';
const DEFAULT_WS_URL = 'ws://127.0.0.1:20258/ws';
const RECONNECT_MS = 2000;
const DRIVER_TIMEOUT_MS = 200_000;
const TAB_LOAD_WAIT_MS = 6_000;
const KEEPALIVE_ALARM = 'chat-bridge-deepseek-keepalive';

const SITE_CFG = {
  deepseek: {
    urlPattern: /^https:\/\/chat\.deepseek\.com\//i,
    chatUrl: 'https://chat.deepseek.com/',
  },
};

let ws = null;
let bridgeWsUrl = DEFAULT_WS_URL;
let extensionToken = null;
let localTargetUrl = null;
let connected = false;
let manualStop = false;
let connectingPromise = null;
let reconnectTimer = null;
let keepaliveInstalled = false;
let requestTail = Promise.resolve();
const activeRequests = new Map();
const pendingTargetAcks = new Map();
const conversationSessions = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(...args) {
  const text = args.map((value) => {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  }).join(' ');
  console.log('[chat-bridge-deepseek bg]', text);
  sendLog('info', text);
}

function sendLog(level, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'log', level, message })); } catch {}
  }
}

function updateBadge(state) {
  const badge = state === 'on'
    ? { text: 'ON', color: '#10b981' }
    : { text: 'OFF', color: '#ef4444' };
  try {
    chrome.action.setBadgeText({ text: badge.text });
    chrome.action.setBadgeBackgroundColor({ color: badge.color });
  } catch {}
}

function normalizeDeepSeekUrl(value) {
  if (!value) return null;
  let parsed;
  try { parsed = new URL(String(value)); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'chat.deepseek.com') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.port && parsed.port !== '443') return null;
  parsed.hash = '';
  return parsed.href;
}

function comparableUrl(value) {
  const normalized = normalizeDeepSeekUrl(value);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.origin}${pathname}${parsed.search}`;
  } catch {
    return normalized;
  }
}

function isSharedChatUrl(value) {
  return /\/a\/chat\/s\//i.test(String(value || ''));
}

async function registerExtension() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${BRIDGE_HTTP_URL}/ext/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ext: 'chat-bridge-deepseek', version: '0.3.0' }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`register status ${response.status}`);
    const data = await response.json();
    if (!data?.extToken) throw new Error('توکن اتصال اکستنشن دریافت نشد');
    extensionToken = data.extToken;
    bridgeWsUrl = data.wsUrl || DEFAULT_WS_URL;
    return { token: extensionToken, url: bridgeWsUrl };
  } finally {
    clearTimeout(timer);
  }
}

function sendMessageToSocket(message, timeoutMs = 10_000, sourceSocket = null) {
  if (message === null || message === undefined) return Promise.resolve(false);
  const target = sourceSocket || ws;
  if (sourceSocket && sourceSocket !== ws) return Promise.resolve(false);
  if (target && target.readyState === WebSocket.OPEN) {
    try {
      target.send(typeof message === 'string' ? message : JSON.stringify(message));
      return Promise.resolve(true);
    } catch {
      // Try a reconnect below only for the current/global connection.
    }
  }
  if (sourceSocket) return Promise.resolve(false);
  return waitForSocketOpen(timeoutMs).then((ready) => {
    if (!ready || !ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(typeof message === 'string' ? message : JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  });
}

function setTargetOnServer(url) {
  const sourceSocket = ws;
  if (!sourceSocket || sourceSocket.readyState !== WebSocket.OPEN) return Promise.resolve(false);
  const id = `target-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pendingTargetAcks.delete(id);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 2_000);
    pendingTargetAcks.set(id, (ack) => finish(Boolean(ack?.ok)));
    sendMessageToSocket({ type: 'chat.target', id, url }, 1_500, sourceSocket)
      .then((sent) => { if (!sent) finish(false); });
  });
}

function waitForSocketOpen(timeoutMs = 10_000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

async function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function waitForTabReady(tabId, timeoutMs = TAB_LOAD_WAIT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

async function ensureDriver(tab) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const response = await sendTabMessage(tab.id, { type: 'ping' });
      if (response?.ok && response.hasInput) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function findChatTab(targetUrl = null) {
  const desired = comparableUrl(targetUrl);
  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter((tab) => {
    const normalized = normalizeDeepSeekUrl(tab.url || '');
    if (!normalized) return false;
    return SITE_CFG.deepseek.urlPattern.test(normalized);
  });
  if (!desired) {
    const normal = candidates.filter((tab) => !isSharedChatUrl(tab.url || ''));
    normal.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
    return normal[0] || null;
  }
  const exact = candidates.filter((tab) => comparableUrl(tab.url || '') === desired);
  exact.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
  return exact[0] || null;
}

async function assertTargetTab(tab, targetUrl) {
  if (!targetUrl) return;
  const expected = comparableUrl(targetUrl);
  let actualUrl = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const current = await chrome.tabs.get(tab.id);
      actualUrl = current.url || '';
      if (comparableUrl(actualUrl) === expected) return;
    } catch (err) {
      throw new Error(`تب هدف قابل بررسی نبود: ${err.message}`);
    }
    await sleep(300);
  }
  try { await chrome.tabs.remove(tab.id); } catch {}
  throw new Error(`URL گفتگو پس از باز شدن تغییر کرد؛ انتظار ${targetUrl} بود، اما ${actualUrl} دریافت شد.`);
}

async function createChatTab(targetUrl = null) {
  const url = normalizeDeepSeekUrl(targetUrl) || SITE_CFG.deepseek.chatUrl;
  const tab = await chrome.tabs.create({ url, active: false, pinned: true });
  await waitForTabReady(tab.id);
  const ready = await ensureDriver(tab);
  if (!ready) {
    try { await chrome.tabs.remove(tab.id); } catch {}
    throw new Error(`صفحهٔ DeepSeek آماده نشد: ${url}`);
  }
  await assertTargetTab(tab, targetUrl);
  return tab;
}

async function findOrCreateChatTab(targetUrl = null) {
  const existing = await findChatTab(targetUrl);
  if (existing) {
    const ready = await ensureDriver(existing);
    if (ready) {
      await assertTargetTab(existing, targetUrl);
      return existing;
    }
    log(`تب موجود آماده نیست: ${existing.id}`);
  }
  return createChatTab(targetUrl);
}

function messageFingerprint(message) {
  try {
    return JSON.stringify({
      role: message?.role || 'user',
      content: message?.content ?? null,
      tool_call_id: message?.tool_call_id ?? null,
      tool_calls: message?.tool_calls ?? null,
    });
  } catch {
    return `${message?.role || 'user'}:${String(message?.content || '')}`;
  }
}

function sessionKeyFor(tab, targetUrl, conversationKey) {
  const identity = conversationKey || comparableUrl(targetUrl) || (tab.url ? `url:${comparableUrl(tab.url)}` : `tab:${tab.id}`);
  return String(identity);
}

const MAX_TOOL_MANIFEST_CHARS = 6000;
const MAX_TOOL_RESULT_CHARS = 8_000;

function formatToolManifest(tools, toolChoice) {
  if (!Array.isArray(tools) || tools.length === 0 || toolChoice === 'none') return '';
  const header = '[Chat Bridge tool protocol]\nAvailable tools (name(argument names)):';
  const footer = [];
  if (toolChoice === 'required') footer.push('You must call one available tool before answering.');
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name) {
    footer.push(`The user selected the tool ${toolChoice.function.name}; prefer this tool when calling.`);
  }
  footer.push('To call a tool, emit a DSML block with invoke name="tool_name" and parameter elements. Do not describe a tool call as ordinary prose.');
  const toolLines = [];
  for (const tool of tools.slice(0, 64)) {
    const fn = tool?.function || tool || {};
    if (!fn.name) continue;
    const properties = fn.parameters?.properties && typeof fn.parameters.properties === 'object'
      ? Object.keys(fn.parameters.properties)
      : [];
    const required = new Set(Array.isArray(fn.parameters?.required) ? fn.parameters.required : []);
    const argumentNames = properties.map((name) => required.has(name) ? `${name}*` : name).join(',');
    const description = String(fn.description || '').replace(/\s+/g, ' ').slice(0, 140);
    toolLines.push(`- ${fn.name}(${argumentNames})${description ? `: ${description}` : ''}`);
  }
  const fixed = `${header}\n${footer.join('\n')}`;
  const available = Math.max(0, MAX_TOOL_MANIFEST_CHARS - fixed.length - 2);
  return `${header}\n${toolLines.join('\n').slice(0, available)}\n${footer.join('\n')}`;
}

function truncateToolResult(value) {
  const text = String(value || '');
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const headLength = Math.floor(MAX_TOOL_RESULT_CHARS * 0.75);
  const tailLength = MAX_TOOL_RESULT_CHARS - headLength;
  const omitted = text.length - MAX_TOOL_RESULT_CHARS;
  return `${text.slice(0, headLength)}\n\n[Tool result truncated: ${omitted} characters omitted. The full result remains available to DSH.]\n\n${text.slice(-tailLength)}`;
}

function messageContent(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

function formatMessageForPrompt(message) {
  const role = message?.role || 'user';
  if (role === 'tool') {
    const name = message.name ? ` ${message.name}` : '';
    const id = message.tool_call_id ? ` id=${message.tool_call_id}` : '';
    return `[Tool result${name}${id}]\n${truncateToolResult(messageContent(message))}\nThe tool has already run; continue the conversation and give the user the result.`;
  }
  if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    const calls = message.tool_calls.map((call) => {
      const fn = call?.function || call || {};
      let args = fn.arguments || {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch {}
      }
      const names = args && typeof args === 'object' ? Object.keys(args).join(',') : '';
      return `${fn.name || 'tool'}(${names})`;
    }).join('; ');
    return `[Previous tool calls] ${calls}`;
  }
  if (role === 'system') return `[System]\n${messageContent(message)}`;
  if (role === 'assistant') return `[Previous assistant]\n${messageContent(message)}`;
  return messageContent(message);
}

function buildPrompt(messages, tools, toolChoice, sessionKey) {
  const session = conversationSessions.get(sessionKey) || {
    sent: new Set(),
    manifest: '',
  };
  const fingerprints = messages.map(messageFingerprint);
  const fresh = messages.filter((message, index) => !session.sent.has(fingerprints[index]));
  const effective = fresh.length > 0 ? fresh : messages.slice(-1);
  const manifest = formatToolManifest(tools, toolChoice);
  const sections = [];
  if (manifest && (manifest !== session.manifest || !session.manifestSent)) sections.push(manifest);
  for (const message of effective) {
    const text = formatMessageForPrompt(message);
    if (text) sections.push(text);
  }
  if (sections.length === 0) sections.push('Continue the conversation.');
  return {
    text: sections.join('\n\n'),
    fingerprints,
    manifest,
  };
}

function commitSession(sessionKey, promptState) {
  const session = conversationSessions.get(sessionKey) || {
    sent: new Set(),
    manifest: '',
  };
  for (const fingerprint of promptState.fingerprints) session.sent.add(fingerprint);
  if (session.sent.size > 400) {
    for (const fingerprint of session.sent) {
      if (session.sent.size <= 200) break;
      session.sent.delete(fingerprint);
    }
  }
  if (promptState.manifest) {
    session.manifest = promptState.manifest;
    session.manifestSent = true;
  }
  conversationSessions.delete(sessionKey);
  conversationSessions.set(sessionKey, session);
  while (conversationSessions.size > 100) {
    const oldest = conversationSessions.keys().next().value;
    conversationSessions.delete(oldest);
  }
}

async function callDriver(tab, message, timeoutMs = DRIVER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    timer = setTimeout(() => {
      if (message.requestId) {
        try { chrome.tabs.sendMessage(tab.id, { type: 'cancel', requestId: message.requestId }); } catch {}
      }
      finish(reject, new Error(`تایم‌اوت درایور برای ${message.type}`));
    }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tab.id, message, (response) => {
        if (chrome.runtime.lastError) {
          finish(reject, new Error(chrome.runtime.lastError.message));
          return;
        }
        finish(resolve, response);
      });
    } catch (err) {
      finish(reject, err);
    }
  });
}

async function runRequest(id, payload, record) {
  const startedAt = Date.now();
  log(`[timing] run_start id=${id}`);
  if (record.cancelled) return { cancelled: true };
  if (payload.site !== 'deepseek') {
    return { error: 'در این نسخه فقط DeepSeek پشتیبانی می‌شود.' };
  }

  const requestedTarget = payload.chatUrl || localTargetUrl;
  const targetUrl = normalizeDeepSeekUrl(requestedTarget);
  if (requestedTarget && !targetUrl) {
    return { error: 'chatUrl باید یک URL معتبر chat.deepseek.com باشد.' };
  }

  const tab = await findOrCreateChatTab(targetUrl);
  log(`[timing] tab_ready ${Date.now() - startedAt}ms id=${id}`);
  record.tabId = tab.id;
  if (record.cancelled) return { cancelled: true };

  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const sessionKey = sessionKeyFor(tab, targetUrl, payload.conversationKey);
  const promptState = buildPrompt(
    Array.isArray(payload.messages) ? payload.messages : [],
    tools,
    payload.toolChoice,
    sessionKey,
  );
  log(`ارسال درخواست ${id} به تب ${tab.id}: ${targetUrl || 'tab موجود'}`);
  log(`[timing] prompt_ready ${Date.now() - startedAt}ms id=${id}`);
  let result;
  try {
    result = await callDriver(tab, {
      type: 'send-and-collect',
      requestId: id,
      text: promptState.text,
      allowedToolNames: tools.map((tool) => tool?.function?.name || tool?.name).filter(Boolean),
    });
    if (result?.ok) commitSession(sessionKey, promptState);
    log(`[timing] driver_done ${Date.now() - startedAt}ms id=${id}`);
  } catch (err) {
    throw err;
  }
  if (result?.error === 'cancelled' || record.cancelled) return { cancelled: true };
  if (!result?.ok) return { error: result?.error || 'driver پاسخ معتبری برنگرداند.' };

  const allowedNames = new Set(
    payload.toolChoice === 'none'
      ? []
      : tools
        .map((tool) => tool?.function?.name || tool?.name)
        .filter((name) => typeof name === 'string' && name.length > 0),
  );
  const allCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  const toolCalls = allCalls.filter((call) => allowedNames.has(call?.name));
  const rejectedText = allCalls
    .filter((call) => !allowedNames.has(call?.name))
    .map((call) => call?.raw || '')
    .filter(Boolean)
    .join('\n');
  const answer = [result.answer || '', rejectedText].filter(Boolean).join('\n');
  const streamed = Boolean(result.streamed);
  record.streamed = Boolean(record.streamed) || streamed;
  if (answer || toolCalls.length > 0) return { answer, toolCalls, streamed };
  return { error: 'driver پاسخ متنی یا tool call معتبری برنگرداند.' };
}

async function streamBack(id, result, record) {
  const startedAt = Date.now();
  if (result.cancelled || record?.cancelled) return;
  if (result.error) {
    const sent = await sendMessageToSocket(
      { type: 'chat.error', id, error: { message: result.error, type: 'extension_error' } },
      10_000,
      record?.socket,
    );
    if (!sent) throw new Error('ارسال خطای driver به bridge ناموفق بود.');
    return;
  }

  // If the driver streamed real text through the hook, the content has already
// been forwarded chunk-by-chunk. In that case we only need to emit the terminal
// event (or the tool call) and must not replay the same text.
if (result.streamed) {
    if (record?.cancelled) return;
    if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) {
      const sent = await sendMessageToSocket(
        { type: 'chat.tool_calls', id, toolCalls: result.toolCalls },
        10_000,
        record?.socket,
      );
      if (!sent) throw new Error('ارسال tool call به bridge ناموفق بود.');
      log(`[timing] tool_call_sent ${Date.now() - startedAt}ms id=${id}`);
      return;
    }
    const finished = await sendMessageToSocket(
      { type: 'chat.done', id, finishReason: 'stop' },
      10_000,
      record?.socket,
    );
    if (!finished) throw new Error('ارسال پایان پاسخ به bridge ناموفق بود.');
    log(`[timing] stream_done ${Date.now() - startedAt}ms id=${id}`);
    return;
  }

  const text = String(result.answer || '');
  const chunkSize = 256;
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    if (record?.cancelled) return;
    const sent = await sendMessageToSocket(
      { type: 'chat.delta', id, delta: text.slice(offset, offset + chunkSize) },
      10_000,
      record?.socket,
    );
    if (!sent) throw new Error('ارتباط با bridge هنگام ارسال پاسخ قطع شد.');
    await sleep(1);
  }
  if (record?.cancelled) return;
  if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) {
    const sent = await sendMessageToSocket(
      { type: 'chat.tool_calls', id, toolCalls: result.toolCalls },
      10_000,
      record?.socket,
    );
    if (!sent) throw new Error('ارسال tool call به bridge ناموفق بود.');
    log(`[timing] tool_call_sent ${Date.now() - startedAt}ms id=${id}`);
    return;
  }
  const finished = await sendMessageToSocket(
    { type: 'chat.done', id, finishReason: 'stop' },
    10_000,
    record?.socket,
  );
  if (!finished) throw new Error('ارسال پایان پاسخ به bridge ناموفق بود.');
  log(`[timing] stream_done ${Date.now() - startedAt}ms id=${id}`);
}

function cancelRequest(id) {
  const record = activeRequests.get(id);
  if (!record) return;
  record.cancelled = true;
  if (record.tabId && record.requestId) {
    try { chrome.tabs.sendMessage(record.tabId, { type: 'cancel', requestId: record.requestId }); } catch {}
  }
}

function processRequest(id, payload, sourceSocket) {
  const record = { cancelled: false, tabId: null, requestId: id, socket: sourceSocket };
  activeRequests.set(id, record);
  const task = requestTail.then(async () => {
    try {
      if (record.cancelled) return;
      const result = await runRequest(id, payload, record);
      try {
        await streamBack(id, result, record);
      } catch (err) {
        if (!record.cancelled) {
          try {
            await sendMessageToSocket({
              type: 'chat.error',
              id,
              error: { message: err.message, type: 'stream_error' },
            }, 10_000, record.socket);
          } catch {}
        }
        sendLog('error', `stream ${id}: ${err.message}`);
      }
    } catch (err) {
      if (!record.cancelled) {
        try {
          await sendMessageToSocket({
            type: 'chat.error',
            id,
            error: { message: err.message, type: 'extension_error' },
          }, 10_000, record.socket);
        } catch {}
      }
    } finally {
      activeRequests.delete(id);
    }
  });
  requestTail = task.catch(() => {});
  return task;
}

function scheduleReconnect() {
  if (manualStop || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

async function connect() {
  if (manualStop) return;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    let registration;
    try {
      registration = await registerExtension();
    } catch (err) {
      log(`ثبت اکستنشن ناموفق بود: ${err.message}`);
      scheduleReconnect();
      return;
    }
    if (manualStop) return;

    let socket;
    try {
      socket = new WebSocket(registration.url, ['chat-bridge', registration.token]);
    } catch (err) {
      log(`ساخت WebSocket ناموفق بود: ${err.message}`);
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket) {
        try { socket.close(); } catch {}
        return;
      }
      connected = true;
      updateBadge('on');
      try {
        socket.send(JSON.stringify({
          type: 'hello',
          payload: { ext: 'chat-bridge-deepseek', version: '0.3.0', sites: ['deepseek'] },
        }));
      } catch {}
      log('متصل به bridge شد');
    };

    socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (message.type === 'chat.target.ack') {
        const resolveAck = pendingTargetAcks.get(message.id);
        if (resolveAck) resolveAck(message);
        return;
      }
      if (message.type === 'chat.cancel') {
        cancelRequest(message.id);
        return;
      }
      if (message.type !== 'chat.request') return;
      const payload = message.payload || {};
      if (!payload.id || !payload.site) return;
      processRequest(payload.id, payload, socket);
    };

    socket.onerror = () => log('خطای WebSocket');
    socket.onclose = () => {
      for (const resolveAck of pendingTargetAcks.values()) resolveAck({ ok: false });
      pendingTargetAcks.clear();
      for (const [id, record] of activeRequests) {
        if (record.socket === socket) cancelRequest(id);
      }
      if (ws !== socket) return;
      connected = false;
      ws = null;
      updateBadge('off');
      log('اتصال bridge بسته شد');
      scheduleReconnect();
    };
  })().finally(() => {
    connectingPromise = null;
  });

  return connectingPromise;
}

async function setupKeepalive() {
  if (keepaliveInstalled) return;
  keepaliveInstalled = true;
  try {
    await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  } catch {}
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM) return;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) connect();
    else if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch {}
    }
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'get-status': {
          const tab = await findChatTab(message.url);
          sendResponse({ connected, activeRequests: [...activeRequests.keys()], sites: ['deepseek'], targetUrl: localTargetUrl || tab?.url || null });
          return;
        }
        case 'stop':
          manualStop = true;
          for (const id of activeRequests.keys()) cancelRequest(id);
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = null;
          if (ws) { try { ws.close(); } catch {} }
          updateBadge('off');
          sendResponse({ ok: true });
          return;
        case 'start':
          manualStop = false;
          connect();
          sendResponse({ ok: true });
          return;
        case 'debug-dom': {
          const target = message.url || localTargetUrl;
          const tab = await findChatTab(target);
          if (!tab) {
            sendResponse({ ok: false, error: 'تب DeepSeek پیدا نشد.' });
            return;
          }
          const response = await sendTabMessage(tab.id, { type: 'debug-dom' });
          sendResponse({ ok: Boolean(response?.ok), debug: response?.debug, error: response?.error });
          return;
        }
        case 'hook-delta': {
          const record = activeRequests.get(message.requestId);
          if (!record || record.cancelled) {
            sendResponse({ ok: false });
            return;
          }
          record.streamed = true;
          record.streamedText = (record.streamedText || '') + (message.delta || '');
          sendMessageToSocket(
            { type: 'chat.delta', id: message.requestId, delta: message.delta || '' },
            10_000,
            record.socket,
          ).then((ok) => sendResponse({ ok })).catch((err) => sendResponse({ ok: false, error: err.message }));
          return;
        }
        case 'driver-heartbeat':
          sendResponse({ ok: true });
          return;
        case 'log':
          log(message.text || '');
          sendResponse({ ok: true });
          return;
        case 'open-tab': {
          const target = message.url ? normalizeDeepSeekUrl(message.url) : SITE_CFG.deepseek.chatUrl;
          if (message.url && !target) {
            sendResponse({ ok: false, error: 'URL معتبر DeepSeek نیست' });
            return;
          }
          localTargetUrl = target;
          await chrome.tabs.create({ url: target, active: true });
          const targetSaved = await setTargetOnServer(target);
          sendResponse({ ok: true, url: target, targetSaved });
          return;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true;
});

chrome.runtime.onStartup?.addListener(() => {
  manualStop = false;
  setupKeepalive();
  connect();
});
chrome.runtime.onInstalled?.addListener(() => {
  manualStop = false;
  setupKeepalive();
  connect();
});

setupKeepalive();
connect();
