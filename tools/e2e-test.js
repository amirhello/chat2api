'use strict';

/**
 * Transport-level E2E test. It simulates the extension, not Chrome DOM.
 * The browser DOM path is exercised by the content script during manual use.
 */

const assert = require('assert');
const WebSocket = require('ws');
const { loadOrCreateApiKey } = require('../bridge/config');

const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.BRIDGE_PORT || 20258);
const API_KEY = process.env.BRIDGE_API_KEY || process.env.CHAT_BRIDGE_API_KEY || loadOrCreateApiKey();
const TARGET_URL = process.env.CHAT_BRIDGE_CHAT_URL || '';

async function register() {
  const response = await fetch(`http://${HOST}:${PORT}/ext/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ext: 'sim', version: '0.3.0' }),
  });
  if (!response.ok) throw new Error(`register failed: ${response.status}`);
  return response.json();
}

async function main() {
  const registration = await register();
  assert.ok(registration.extToken, 'extension token was not returned');
  const socket = new WebSocket(registration.wsUrl, ['chat-bridge', registration.extToken]);
  const answer = 'پاسخ شبیه‌سازی‌شدهٔ Chat Bridge DeepSeek ✅';

  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('E2E timeout')), 15_000);
    socket.on('open', async () => {
      socket.send(JSON.stringify({ type: 'hello', payload: { ext: 'sim', version: '0.3.0' } }));
      const body = {
        model: 'deepseek',
        stream: true,
        messages: [{ role: 'user', content: 'سلام' }],
      };
      if (TARGET_URL) body.chat_url = TARGET_URL;
      const response = await fetch(`http://${HOST}:${PORT}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      clearTimeout(timer);
      resolve({ status: response.status, text });
    });
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'chat.request') return;
      if (TARGET_URL) assert.strictEqual(message.payload.chatUrl, TARGET_URL);
      socket.send(JSON.stringify({ type: 'chat.delta', id: message.payload.id, delta: answer }));
      socket.send(JSON.stringify({ type: 'chat.done', id: message.payload.id, finishReason: 'stop' }));
    });
    socket.on('error', reject);
  });

  const output = await result;
  assert.strictEqual(output.status, 200);
  assert.ok(output.text.includes(answer), 'SSE answer was not received');
  console.log('✅ transport E2E passed');
  socket.close();
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exitCode = 1;
});
