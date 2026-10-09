'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = Number(process.env.TEST_BRIDGE_PORT || 20259);
const HOST = '127.0.0.1';
const API_KEY = 'cb_test_cancel_token';
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${HOST}:${PORT}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('server did not start');
}

async function waitForIdle() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://${HOST}:${PORT}/health`);
    const data = await response.json();
    if (data.inflight === 0 && data.queue === 0) return;
    await sleep(100);
  }
  throw new Error('server queue did not drain');
}

async function main() {
  const server = spawn(process.execPath, ['bridge/server.js'], {
    cwd: ROOT,
    env: { ...process.env, BRIDGE_PORT: String(PORT), BRIDGE_API_KEY: API_KEY },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  let socket;
  try {
    await waitForServer();
    const registrationResponse = await fetch(`http://${HOST}:${PORT}/ext/register`, { method: 'POST' });
    const registration = await registrationResponse.json();
    assert.ok(registration.extToken);

    socket = new WebSocket(registration.wsUrl, ['chat-bridge', registration.extToken]);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    let firstRequestSeen = false;
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'chat.request' && !firstRequestSeen) {
        firstRequestSeen = true;
        setTimeout(() => socket.close(), 50);
      }
    });

    const firstResponse = await fetch(`http://${HOST}:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: 'deepseek', stream: true, messages: [{ role: 'user', content: 'first' }] }),
    }).then((response) => response.text());

    assert.ok(firstRequestSeen, 'extension did not receive the request');
    assert.ok(firstResponse.includes('error'), 'disconnect did not produce a bounded error response');
    await waitForIdle();

    const controller = new AbortController();
    const aborted = fetch(`http://${HOST}:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: 'deepseek', stream: true, messages: [{ role: 'user', content: 'abort' }] }),
      signal: controller.signal,
    }).catch((err) => err);
    setTimeout(() => controller.abort(), 100);
    await aborted;
    await waitForIdle();

    console.log('✅ cancellation/queue tests passed');
  } finally {
    if (socket) {
      try { socket.close(); } catch {}
    }
    server.kill();
  }
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exitCode = 1;
});
