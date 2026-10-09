'use strict';

/**
 * Chat Bridge DeepSeek — local OpenAI-compatible bridge
 *
 * The HTTP API runs on localhost. A Chrome extension connects with a
 * short-lived extension token, receives a request, and returns the response
 * from a user-selected DeepSeek page.
 */

const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

const {
  PORT,
  HOST,
  SITES,
  DEFAULT_MODEL,
  REQUEST_TIMEOUT_MS,
  QUEUE_CONCURRENCY,
  WS_PING_MS,
  EXTENSION_TOKEN_TTL_MS,
  resolveSite,
  normalizeChatUrl,
  loadOrCreateApiKey,
  resolveKeyFile,
  loadSavedChatUrl,
  saveChatUrl,
  clearSavedChatUrl,
} = require('./config');

const API_KEY = loadOrCreateApiKey();
const publicHost = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;

let extSocket = null;
let extCapabilities = {};
let defaultChatUrl = loadSavedChatUrl();
let running = 0;

const inflight = new Map();
const queue = [];
const extensionTokens = new Map();

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function makeChatId(site) {
  return `chatcmpl-deepseek-${site}-${crypto.randomBytes(8).toString('hex')}`;
}

function sendToExt(message, socket = extSocket) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(typeof message === 'string' ? message : JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function enqueue(task, state = null) {
  queue.push({ task, state });
  pumpQueue();
}

function removeQueuedState(state) {
  const index = queue.findIndex((entry) => entry.state === state);
  if (index >= 0) queue.splice(index, 1);
}

function pumpQueue() {
  while (running < QUEUE_CONCURRENCY && queue.length > 0) {
    const entry = queue.shift();
    if (entry.state?.settled) continue;
    running += 1;
    let completed = false;
    const done = () => {
      if (completed) return;
      completed = true;
      running -= 1;
      pumpQueue();
    };
    try {
      entry.task(done);
    } catch (err) {
      console.error('[queue] task crashed:', err);
      done();
    }
  }
}

function sendJsonError(res, status, message, type = 'invalid_request_error') {
  res.status(status).json({ error: { message, type } });
}

function tokensEqual(provided) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  const token = bearer ? bearer[1].trim() : String(req.headers['x-api-key'] || '').trim();

  if (!token || !tokensEqual(token)) {
    sendJsonError(res, 401, 'API Key نامعتبر است.', 'auth_error');
    return;
  }
  next();
}

function responseCanBeWritten(res) {
  return !!res && !res.writableEnded && !res.destroyed;
}

function writeStreamError(res, error) {
  if (!responseCanBeWritten(res)) return;
  try {
    res.write(`data: ${JSON.stringify({ error })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch {
    // The client may have disconnected while the error was being written.
  }
}

function writeError(res, stream, error, id) {
  if (!responseCanBeWritten(res)) return;
  if (stream && res.headersSent) {
    writeStreamError(res, error);
    return;
  }
  if (res.headersSent) {
    try {
      res.end(JSON.stringify({ error, id }));
    } catch {}
    return;
  }
  try {
    res.status(502).json({ error, id });
  } catch {}
}

function sendChunk(state, delta) {
  if (!delta || !responseCanBeWritten(state.res)) return;
  const chunk = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.meta.model,
    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
  };
  try {
    state.res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    state.contentStreamed = true;
  } catch {}
}

function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.slice(0, 16).flatMap((call, index) => {
    if (!call || typeof call !== 'object') return [];
    const name = String(call.name || call.function?.name || '').trim();
    if (!name) return [];
    let args = call.arguments ?? call.function?.arguments ?? {};
    if (typeof args !== 'string') {
      try { args = JSON.stringify(args); } catch { args = '{}'; }
    }
    if (!args.trim()) args = '{}';
    return [{
      id: String(call.id || `call_${newToolCallId()}`),
      name,
      arguments: args,
      index,
    }];
  });
}

function newToolCallId() {
  return `${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function sendToolCallChunks(state) {
  if (!responseCanBeWritten(state.res)) return;
  if (state.fullText && !state.contentStreamed) sendChunk(state, state.fullText);
  state.toolCalls.forEach((call, index) => {
    const chunk = {
      id: state.id,
      object: 'chat.completion.chunk',
      created: state.created,
      model: state.meta.model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index,
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          }],
        },
        finish_reason: null,
      }],
    };
    try { state.res.write(`data: ${JSON.stringify(chunk)}\n\n`); } catch {}
  });
}

function sendToolCallFinish(state) {
  sendFinish(state, 'tool_calls');
}

function sendFinish(state, finishReason = 'stop') {
  if (!responseCanBeWritten(state.res)) return;
  const chunk = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.meta.model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason || 'stop' }],
  };
  try {
    state.res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    state.res.write('data: [DONE]\n\n');
    state.res.end();
  } catch {}
}

function sendFullResponse(state) {
  if (!responseCanBeWritten(state.res)) return;
  const message = { role: 'assistant', content: state.fullText || null };
  if (state.toolCalls.length > 0) {
    message.tool_calls = state.toolCalls.map((call, index) => ({
      index,
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  const output = {
    id: state.id,
    object: 'chat.completion',
    created: state.created,
    model: state.meta.model,
    choices: [{
      index: 0,
      message,
      finish_reason: state.finishReason || (state.toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  try {
    if (!state.res.headersSent) state.res.json(output);
    else state.res.end(JSON.stringify(output));
  } catch {}
}

function createState({ id, site, body, messages, stream, created, res, chatUrl }) {
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  return {
    id,
    site,
    body,
    messages,
    stream,
    created,
    res,
    chatUrl,
    chunks: [],
    startedAt: Date.now(),
    firstDeltaAt: null,
    fullText: '',
    contentStreamed: false,
    toolCalls: [],
    finishReason: null,
    timer: null,
    settled: false,
    cancelled: false,
    clientCancelled: false,
    socket: extSocket,
    done,
    resolveDone,
    meta: { model: body.model || site, created },
    closeHandler: null,
  };
}

function settleState(state, error = null, finishReason = 'stop', toolCalls = null) {
  if (!state || state.settled) return false;
  state.settled = true;
  state.toolCalls = normalizeToolCalls(toolCalls);
  state.finishReason = state.toolCalls.length > 0
    ? 'tool_calls'
    : (finishReason || state.finishReason || 'stop');
  removeQueuedState(state);
  if (state.timer) clearTimeout(state.timer);

  if (error) {
    if (!state.clientCancelled && responseCanBeWritten(state.res)) {
      if (state.stream) writeStreamError(state.res, error);
      else writeError(state.res, false, error, state.id);
    }
  } else if (state.toolCalls.length > 0) {
    if (state.stream) {
      sendToolCallChunks(state);
      sendToolCallFinish(state);
    } else {
      sendFullResponse(state);
    }
  } else if (state.stream) {
    sendFinish(state, state.finishReason);
  } else {
    sendFullResponse(state);
  }

  state.resolveDone();
  return true;
}

function cleanupState(state) {
  if (state.timer) clearTimeout(state.timer);
  if (state.closeHandler && responseCanBeWritten(state.res)) {
    state.res.off('close', state.closeHandler);
  }
  inflight.delete(state.id);
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.slice(0, 64).filter((tool) => {
    const fn = tool?.function;
    return tool?.type === 'function' && fn && typeof fn.name === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(fn.name);
  });
}

function normalizeToolChoice(value) {
  if (value === 'none' || value === 'auto' || value === 'required') return value;
  if (value && typeof value === 'object' && typeof value.function?.name === 'string') return value;
  return undefined;
}

function parseTargetUrl(body) {
  const raw = body.chat_url
    ?? body.chatUrl
    ?? body.url
    ?? body.target_url
    ?? body.extra?.chat_url
    ?? body.metadata?.chat_url;
  if (raw === undefined || raw === null || raw === '') return defaultChatUrl;
  return normalizeChatUrl(raw);
}

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.url}`);
  next();
});

app.get('/v1/models', authMiddleware, (_req, res) => {
  const data = Object.entries(SITES).map(([site, cfg]) => ({
    id: site,
    object: 'model',
    created: 0,
    owned_by: 'chat-bridge-deepseek',
    context_window: 131072,
    aliases: cfg.aliases,
  }));
  res.json({ object: 'list', data });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    extension_connected: !!extSocket && extSocket.readyState === WebSocket.OPEN,
    capabilities: extCapabilities,
    inflight: inflight.size,
    queue: queue.length,
    has_target: !!defaultChatUrl,
  });
});

// The extension receives only a short-lived WebSocket token, never the API key.
function pruneExtensionTokens() {
  const cutoff = Date.now() - EXTENSION_TOKEN_TTL_MS;
  for (const [token, record] of extensionTokens) {
    if (record.createdAt < cutoff) extensionTokens.delete(token);
  }
}

app.post('/ext/register', (_req, res) => {
  pruneExtensionTokens();
  const token = crypto.randomBytes(32).toString('hex');
  extensionTokens.set(token, { createdAt: Date.now(), used: false });
  res.json({
    extToken: token,
    wsUrl: `ws://${publicHost}:${PORT}/ws`,
    expiresInMs: EXTENSION_TOKEN_TTL_MS,
  });
});

app.get('/v1/chat/target', authMiddleware, (_req, res) => {
  res.json({ url: defaultChatUrl });
});

function setTargetUrl(req, res) {
  try {
    const url = normalizeChatUrl(req.body?.url ?? req.body?.chat_url ?? req.body?.chatUrl);
    if (!url) {
      sendJsonError(res, 400, 'یک URL معتبر DeepSeek ارسال کنید.');
      return;
    }
    try {
      saveChatUrl(url);
      defaultChatUrl = url;
    } catch (err) {
      sendJsonError(res, 500, `ذخیرهٔ دائمی URL ناموفق بود: ${err.message}`, 'target_persistence_error');
      return;
    }
    res.json({ ok: true, url: defaultChatUrl });
  } catch (err) {
    sendJsonError(res, 400, err.message);
  }
}

app.post('/v1/chat/target', authMiddleware, setTargetUrl);
app.post('/v1/chat/url', authMiddleware, setTargetUrl);

app.delete('/v1/chat/target', authMiddleware, (_req, res) => {
  try {
    clearSavedChatUrl();
    defaultChatUrl = null;
  } catch (err) {
    sendJsonError(res, 500, `حذف URL ذخیره‌شده ناموفق بود: ${err.message}`, 'target_persistence_error');
    return;
  }
  res.json({ ok: true, url: null });
});

app.post('/v1/chat/completions', authMiddleware, (req, res) => {
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    sendJsonError(res, 400, 'messages الزامی است.');
    return;
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    sendJsonError(res, 400, 'stream باید boolean باشد.');
    return;
  }

  const site = body.model ? resolveSite(body.model) : resolveSite(DEFAULT_MODEL) || 'deepseek';
  if (site !== 'deepseek') {
    sendJsonError(res, 400, 'در این نسخه فقط مدل deepseek پشتیبانی می‌شود.');
    return;
  }

  let chatUrl;
  try {
    chatUrl = parseTargetUrl(body);
  } catch (err) {
    sendJsonError(res, 400, err.message);
    return;
  }

  const stream = body.stream !== false;
  if (!extSocket || extSocket.readyState !== WebSocket.OPEN) {
    sendJsonError(res, 503, 'اکستنشن Chat Bridge به سرور وصل نیست.', 'extension_unavailable');
    return;
  }

  const id = makeChatId(site);
  const state = createState({
    id,
    site,
    body,
    messages,
    stream,
    created: nowSeconds(),
    res,
    chatUrl,
  });
  inflight.set(id, state);

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
  }

  state.closeHandler = () => {
    if (state.settled) return;
    state.cancelled = true;
    state.clientCancelled = true;
    sendToExt({ type: 'chat.cancel', id }, state.socket);
    settleState(state, { message: 'کلاینت درخواست را لغو کرد.', type: 'cancelled' });
  };
  res.once('close', state.closeHandler);

  enqueue((done) => {
    if (state.settled) {
      cleanupState(state);
      done();
      return;
    }
    armRequestTimer(state);
    runRequest(state)
      .catch((err) => {
        if (!state.settled) {
          settleState(state, { message: String(err.message || err), type: 'internal_error' });
        }
      })
      .finally(() => {
        cleanupState(state);
        done();
      });
  }, state);
});

function armRequestTimer(state) {
  if (state.timer || state.settled) return;
  state.timer = setTimeout(() => {
    if (state.settled) return;
    sendToExt({ type: 'chat.cancel', id: state.id }, state.socket);
    settleState(state, { message: 'تایم‌اوت: پاسخی از صفحهٔ DeepSeek دریافت نشد.', type: 'timeout' });
  }, REQUEST_TIMEOUT_MS);
}

async function runRequest(state) {
  state.socket = extSocket;
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    settleState(state, { message: 'اکستنشن در حال ارسال قطع شد.', type: 'extension_unavailable' });
    return;
  }

  const payload = {
    id: state.id,
    site: state.site,
    model: state.body.model || state.site,
    chatUrl: state.chatUrl,
    messages: state.messages,
    tools: normalizeTools(state.body.tools),
    toolChoice: normalizeToolChoice(state.body.tool_choice),
    parallelToolCalls: state.body.parallel_tool_calls,
    conversationKey: state.body.conversation_key || state.body.session_id || state.body.metadata?.session_id,
    temperature: state.body.temperature,
    max_tokens: state.body.max_tokens,
    extra: state.body.extra || {},
  };

  if (!sendToExt({ type: 'chat.request', payload }, state.socket)) {
    settleState(state, { message: 'ارسال درخواست به اکستنشن ناموفق بود.', type: 'extension_unavailable' });
    return;
  }

  await state.done;
}

function handleExtMessage(raw, socket) {
  if (socket !== extSocket) return;
  let message;
  try {
    message = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    console.error('[ws] پیام نامعتبر:', err.message);
    return;
  }

  if (!message || typeof message !== 'object' || Array.isArray(message)) return;

  if (message.type === 'hello' || message.type === 'status' || message.type === 'log') {
    if (message.type === 'hello') {
      extCapabilities = message.payload || {};
      console.log(`[ws] status: ${JSON.stringify(extCapabilities)}`);
    } else if (message.type === 'log') {
      console.log(`[ext] ${message.message || ''}`);
    }
    return;
  }

  if (message.type === 'chat.target') {
    try {
      const url = normalizeChatUrl(message.url);
      if (!url) throw new Error('URL نامعتبر است');
      saveChatUrl(url);
      defaultChatUrl = url;
      sendToExt({ type: 'chat.target.ack', id: message.id, ok: true, url }, socket);
      console.log(`[target] URL از popup اعمال شد: ${url}`);
    } catch (err) {
      sendToExt({ type: 'chat.target.ack', id: message.id, ok: false, error: err.message }, socket);
      console.warn(`[target] اعمال URL از popup ناموفق بود: ${err.message}`);
    }
    return;
  }

  if (!message.id) return;
  const state = inflight.get(message.id);
  if (!state || state.settled) return;

  switch (message.type) {
    case 'chat.delta': {
      const delta = String(message.delta || '');
      if (!delta) break;
      state.chunks.push(delta);
      state.fullText += delta;
      if (state.firstDeltaAt === null) {
        state.firstDeltaAt = Date.now();
        console.log(`[timing] first_delta ${state.firstDeltaAt - state.startedAt}ms id=${message.id}`);
      }
      if (state.stream) sendChunk(state, delta);
      break;
    }
    case 'chat.tool_calls':
      console.log(`[timing] tool_calls_received ${Date.now() - state.startedAt}ms id=${message.id}`);
      settleState(state, null, 'tool_calls', message.toolCalls);
      break;
    case 'chat.done':
      console.log(`[timing] done_received ${Date.now() - state.startedAt}ms id=${message.id}`);
      settleState(state, null, message.finishReason || 'stop', message.toolCalls);
      break;
    case 'chat.error':
      settleState(state, message.error || { message: 'خطای ناشناخته از اکستنشن', type: 'extension_error' });
      break;
    default:
      break;
  }
}

function failRequestsForSocket(socket, message) {
  for (const state of inflight.values()) {
    if (state.socket !== socket || state.settled) continue;
    settleState(state, { message, type: 'extension_unavailable' });
  }
}

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: (info) => {
    const raw = info.req.headers['sec-websocket-protocol'];
    const protocols = raw ? raw.split(',').map((value) => value.trim()) : [];
    const token = protocols[1];
    const record = extensionTokens.get(token);
    const origin = info.req.headers.origin;
    const allowedOrigin = !origin
      || origin.startsWith('chrome-extension://')
      || origin === `http://${publicHost}:${PORT}`
      || origin === `http://localhost:${PORT}`;
    if (
      protocols[0] !== 'chat-bridge'
      || !record
      || record.used
      || Date.now() - record.createdAt > EXTENSION_TOKEN_TTL_MS
      || !allowedOrigin
    ) {
      console.warn('[ws] اتصال بدون token معتبر رد شد');
      return false;
    }
    record.used = true;
    return true;
  },
});

wss.on('connection', (socket, req) => {
  const raw = req.headers['sec-websocket-protocol'];
  const protocols = raw ? raw.split(',').map((value) => value.trim()) : [];
  if (protocols[0]) {
    try { socket.protocol = protocols[0]; } catch {}
  }

  if (extSocket && extSocket !== socket && extSocket.readyState === WebSocket.OPEN) {
    try { extSocket.close(1012, 'replaced by a newer extension connection'); } catch {}
  }
  extSocket = socket;
  console.log('[ws] اکستنشن متصل شد ✅');

  const pingTimer = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      try { socket.ping(); } catch {}
    }
  }, WS_PING_MS);

  socket.on('message', (data) => handleExtMessage(data.toString(), socket));
  socket.on('close', () => {
    clearInterval(pingTimer);
    failRequestsForSocket(socket, 'اتصال اکستنشن قطع شد.');
    if (extSocket === socket) {
      extSocket = null;
      extCapabilities = {};
      console.log('[ws] اکستنشن قطع شد ❌');
    }
  });
  socket.on('error', (err) => console.error('[ws] خطا:', err.message));
});

function start() {
  server.once('error', (err) => {
    console.error(`[server] listen failed: ${err.message}`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log([
      '',
      '═══════════════════════════════════════════════════════════',
      '  Chat Bridge DeepSeek — آمادهٔ اتصال اکستنشن',
      '═══════════════════════════════════════════════════════════',
      `  API endpoint : http://${publicHost}:${PORT}/v1/chat/completions`,
      `  Target API   : POST http://${publicHost}:${PORT}/v1/chat/target`,
      `  Health       : http://${publicHost}:${PORT}/health`,
      `  WebSocket    : ws://${publicHost}:${PORT}/ws`,
      `  API key file : ${resolveKeyFile()}`,
      '  برای دیدن کلید: node bridge/print-key.js',
      '═══════════════════════════════════════════════════════════',
      '',
    ].join('\n'));
  });
}

if (require.main === module) {
  process.on('uncaughtException', (err) => console.error('[fatal] uncaughtException:', err));
  process.on('unhandledRejection', (err) => console.error('[fatal] unhandledRejection:', err));
  start();
}

module.exports = { app, server, wss, start };
