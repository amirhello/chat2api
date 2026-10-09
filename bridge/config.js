'use strict';

/**
 * Chat Bridge DeepSeek — configuration
 *
 * This copy intentionally uses its own key file by default so the original
 * project and its key are not shared accidentally.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const env = process.env;
const PROJECT_DIR = path.join(__dirname, '..');
const DSH_HOME = env.DSH_HOME || path.join(os.homedir(), '.dsh');

const PORT = tcpPort(env.BRIDGE_PORT, 20258);
const requestedHost = env.BRIDGE_HOST || '127.0.0.1';
const HOST = '127.0.0.1';
if (!['127.0.0.1', 'localhost'].includes(requestedHost)) {
  console.warn(`[config] BRIDGE_HOST غیرلوپ‌بکن نادیده گرفته شد؛ bridge فقط روی 127.0.0.1 گوش می‌دهد.`);
}

// Keep the new working copy independent from the original project's key.
const KEY_FILE = env.BRIDGE_KEY_FILE || path.join(PROJECT_DIR, '.chat-bridge-deepseek.key');
const KEY_FILE_FALLBACK = env.BRIDGE_KEY_FILE_FALLBACK || path.join(PROJECT_DIR, '.chat-bridge.key');
const TARGET_FILE = env.BRIDGE_TARGET_FILE || path.join(PROJECT_DIR, '.chat-bridge-target.json');

const SITES = {
  deepseek: {
    urlPattern: /^https:\/\/chat\.deepseek\.com\//i,
    chatUrl: 'https://chat.deepseek.com/',
    aliases: ['deepseek', 'deepseek-chat', 'deepseek-coder', 'ds'],
  },
};

const DEFAULT_MODEL = env.BRIDGE_DEFAULT_MODEL || 'deepseek';
const REQUEST_TIMEOUT_MS = positiveInt(env.BRIDGE_REQUEST_TIMEOUT_MS, 240_000);
// One browser conversation must receive one operation at a time.
const QUEUE_CONCURRENCY = 1;
const WS_PING_MS = positiveInt(env.BRIDGE_WS_PING_MS, 25_000);
const EXTENSION_TOKEN_TTL_MS = positiveInt(env.BRIDGE_EXTENSION_TOKEN_TTL_MS, 10 * 60_000);

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function tcpPort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

/**
 * Only allow a real DeepSeek page URL. This keeps the extension from being
 * used as a generic automation bridge for arbitrary websites.
 */
function normalizeChatUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 4096) {
    throw new Error('chat_url باید یک رشتهٔ URL معتبر باشد');
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('chat_url معتبر نیست');
  }

  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'chat.deepseek.com') {
    throw new Error('فقط URLهای https://chat.deepseek.com/ مجاز هستند');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL نباید username یا password داشته باشد');
  }
  if (parsed.port && parsed.port !== '443') {
    throw new Error('پورت سفارشی برای chat.deepseek.com مجاز نیست');
  }

  parsed.hash = '';
  return parsed.href;
}

function isAllowedChatUrl(value) {
  try {
    return !!normalizeChatUrl(value);
  } catch {
    return false;
  }
}

function resolveSite(modelId) {
  if (!modelId) return null;
  const id = String(modelId).toLowerCase().trim();
  for (const [site, cfg] of Object.entries(SITES)) {
    if (site === id || cfg.aliases.includes(id)) return site;
  }
  if (id.includes('deepseek')) return 'deepseek';
  return null;
}

function loadOrCreateApiKey() {
  const configuredKey = String(env.BRIDGE_API_KEY || '').trim();
  if (configuredKey) return configuredKey;

  for (const file of [KEY_FILE, KEY_FILE_FALLBACK]) {
    try {
      if (fs.existsSync(file)) {
        const key = fs.readFileSync(file, 'utf8').trim();
        if (key) return key;
      }
    } catch (err) {
      console.warn(`[config] خواندن ${file} ناموفق بود: ${err.message}`);
    }
  }

  const key = 'cb_' + crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
    console.info(`[config] کلید جدید ساخته شد و در ${KEY_FILE} ذخیره شد`);
    module.exports.KEY_FILE_USED = KEY_FILE;
    return key;
  } catch (err) {
    console.warn(`[config] نوشتن در ${KEY_FILE} ناموفق بود: ${err.message}`);
  }

  try {
    fs.writeFileSync(KEY_FILE_FALLBACK, key, { mode: 0o600 });
    console.info(`[config] کلید در ${KEY_FILE_FALLBACK} ذخیره شد`);
    module.exports.KEY_FILE_USED = KEY_FILE_FALLBACK;
    return key;
  } catch (err) {
    console.warn(`[config] ذخیره کلید ناموفق بود: ${err.message}`);
  }

  throw new Error('ذخیرهٔ API Key ممکن نیست؛ BRIDGE_API_KEY را تنظیم کنید یا مسیر پروژه را قابل‌نوشتن کنید.');
}

function resolveKeyFile() {
  if (env.BRIDGE_API_KEY) return '(env BRIDGE_API_KEY)';
  if (module.exports.KEY_FILE_USED) return module.exports.KEY_FILE_USED;
  for (const file of [KEY_FILE, KEY_FILE_FALLBACK]) {
    try {
      if (fs.existsSync(file)) return file;
    } catch {}
  }
  return KEY_FILE;
}

function loadSavedChatUrl() {
  try {
    if (!fs.existsSync(TARGET_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(TARGET_FILE, 'utf8'));
    return normalizeChatUrl(data.url);
  } catch (err) {
    console.warn(`[config] خواندن URL ذخیره‌شده ناموفق بود: ${err.message}`);
    return null;
  }
}

function saveChatUrl(url) {
  fs.mkdirSync(path.dirname(TARGET_FILE), { recursive: true });
  fs.writeFileSync(TARGET_FILE, JSON.stringify({ url }, null, 2) + '\n');
}

function clearSavedChatUrl() {
  try { fs.unlinkSync(TARGET_FILE); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = {
  PORT,
  HOST,
  DSH_HOME,
  KEY_FILE,
  KEY_FILE_FALLBACK,
  TARGET_FILE,
  SITES,
  DEFAULT_MODEL,
  REQUEST_TIMEOUT_MS,
  QUEUE_CONCURRENCY,
  WS_PING_MS,
  EXTENSION_TOKEN_TTL_MS,
  resolveSite,
  normalizeChatUrl,
  isAllowedChatUrl,
  loadOrCreateApiKey,
  resolveKeyFile,
  loadSavedChatUrl,
  saveChatUrl,
  clearSavedChatUrl,
};
