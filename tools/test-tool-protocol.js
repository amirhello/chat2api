'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = Number(process.env.TEST_TOOL_PORT || (21000 + (process.pid % 1000)));
const HOST = '127.0.0.1';
const API_KEY = 'cb_test_tool_protocol';
const ROOT = path.join(__dirname, '..');
const TARGET_FILE = path.join(os.tmpdir(), `chat-bridge-target-${process.pid}.json`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function timedFetch(url, options = {}, timeoutMs = 8_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await timedFetch(`http://${HOST}:${PORT}/health`, {}, 1_000);
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('server did not start');
}

function parseSse(text) {
  return text.split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((value) => value && value !== '[DONE]')
    .map((value) => JSON.parse(value));
}

async function main() {
  const server = spawn(process.execPath, ['bridge/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      BRIDGE_PORT: String(PORT),
      BRIDGE_API_KEY: API_KEY,
      BRIDGE_TARGET_FILE: TARGET_FILE,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  let socket;
  try {
    await waitForServer();
    const registrationResponse = await timedFetch(`http://${HOST}:${PORT}/ext/register`, { method: 'POST' });
    const registration = await registrationResponse.json();
    assert.ok(registration.extToken);
    socket = new WebSocket(registration.wsUrl, ['chat-bridge', registration.extToken]);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const pending = new Map();
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'chat.request') return;
      assert.strictEqual(message.payload.tools[0].function.name, 'bash');
      assert.strictEqual(message.payload.toolChoice, 'auto');
      const reply = {
        type: 'chat.tool_calls',
        id: message.payload.id,
        toolCalls: [{
          id: 'call_test_1',
          name: 'bash',
          arguments: { command: 'ping -n 4 google.com' },
        }],
      };
      pending.set(message.payload.id, true);
      socket.send(JSON.stringify(reply));
    });

    const response = await timedFetch(`http://${HOST}:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek',
        stream: true,
        tools: [{
          type: 'function',
          function: {
            name: 'bash',
            description: 'اجرای فرمان',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string' } },
              required: ['command'],
            },
          },
        }],
        tool_choice: 'auto',
        messages: [{ role: 'user', content: 'پینگ بگیر' }],
      }),
    });
    assert.strictEqual(response.status, 200);
    const chunks = parseSse(await response.text());
    const toolChunk = chunks.find((chunk) => chunk.choices?.[0]?.delta?.tool_calls);
    assert.ok(toolChunk, 'tool_calls chunk was not returned');
    assert.strictEqual(toolChunk.choices[0].delta.tool_calls[0].function.name, 'bash');
    assert.deepStrictEqual(JSON.parse(toolChunk.choices[0].delta.tool_calls[0].function.arguments), {
      command: 'ping -n 4 google.com',
    });
    assert.ok(chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === 'tool_calls'));

    const nonStreamResponse = await timedFetch(`http://${HOST}:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek',
        stream: false,
        tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
        messages: [{ role: 'user', content: 'پینگ بگیر' }],
        tool_choice: 'auto',
      }),
    });
    const nonStream = await nonStreamResponse.json();
    assert.strictEqual(nonStream.choices[0].finish_reason, 'tool_calls');
    assert.strictEqual(nonStream.choices[0].message.tool_calls[0].function.name, 'bash');
    console.log('✅ tool protocol test passed');
  } finally {
    if (socket) {
      try { socket.close(); } catch {}
    }
    server.kill();
    try { require('fs').unlinkSync(TARGET_FILE); } catch {}
  }
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exitCode = 1;
});
