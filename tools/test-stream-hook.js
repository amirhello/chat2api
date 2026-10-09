'use strict';

/**
 * Tests the DSML-aware streaming policy used by the MAIN-world hook.
 *
 * Policy under test:
 *   - plain prose streams incrementally (this is the latency-critical path)
 *   - once a DSML marker appears we stop streaming and buffer silently
 *   - at finish() every DSML region is removed and the remaining prose is emitted
 *   - the raw stream always keeps the DSML so tool calls can be parsed later
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'content', 'deepseek-stream-hook.js'),
  'utf8',
);

const start = source.indexOf("const TAG =");
const end = source.indexOf('function urlOf(');
assert.ok(start >= 0 && end > start, 'hook policy section not found');

const M = '｜｜DSML｜｜';

function makeHook() {
  const sandbox = { window: {}, console };
  sandbox.window = sandbox;
  const emitted = [];
  const posts = [];
  vm.runInNewContext(`${source.slice(start, end)}\nthis.api = { reset, handleRaw, finish, state, stripDsmlRegions };`, sandbox);
  sandbox.window.postMessage = (msg) => {
    posts.push(msg.payload);
    if (msg.payload.kind === 'chunk') emitted.push(msg.payload.delta);
  };
  return { api: sandbox.api, emitted, posts };
}

// ---- 1. plain prose streams incrementally -------------------------------
{
  const { api, emitted } = makeHook();
  api.reset('r1');
  api.handleRaw('سلام ');
  api.handleRaw('دنیا');
  assert.deepStrictEqual(emitted, ['سلام ', 'دنیا']);
  api.finish();
  assert.strictEqual(emitted.join(''), 'سلام دنیا');
}

// ---- 2. a partial marker at the tail is held back -----------------------
{
  const { api, emitted } = makeHook();
  api.reset('r2');
  api.handleRaw('متن');
  api.handleRaw(`<｜｜DS`);
  assert.deepStrictEqual(emitted, ['متن'], 'a partial marker must not be emitted');
  api.handleRaw('ML｜｜ calls>');
  api.handleRaw(`</${M}>`);
  api.finish();
  assert.ok(!emitted.join('').includes('DSML'), 'DSML must never reach the client');
}

// ---- 3. real DeepSeek tool block is fully removed ----------------------
{
  const { api, emitted, posts } = makeHook();
  api.reset('r3');
  const dsml =
    `<${M} calls>` +
    `<${M} invoke name="pwsh">` +
    `<${M} parameter name="command" string="true">cmd /c "ping -n 4 google.com"<${M} parameter>` +
    `<${M} parameter name="description" string="true">Ping google.com<${M} parameter>` +
    `</${M} invoke>` +
    `</${M}>`;

  api.handleRaw('قبل از ابزار ');
  for (const piece of dsml.match(/<[^>]+>|[\s\S]+?(?=<|$)/g) || [dsml]) {
    api.handleRaw(piece);
  }
  api.handleRaw(' بعد از ابزار');
  api.finish();

  const text = emitted.join('');
  assert.strictEqual(text, 'قبل از ابزار  بعد از ابزار', 'tool block must be stripped entirely');
  assert.ok(!text.includes('DSML'));
  assert.ok(!text.includes('ping -n 4 google.com'));

  // raw is preserved for the DSML parser in the driver
  const complete = posts.find((p) => p.kind === 'raw-complete');
  assert.ok(complete, 'raw-complete must be posted');
  assert.ok(complete.raw.includes('DSML'));
  assert.ok(complete.raw.includes('ping -n 4 google.com'));
}

// ---- 4. tool call split across many chunks -----------------------------
{
  const { api, emitted } = makeHook();
  api.reset('r4');
  const chunks = [
    'متن اول ',
    `<${M} calls>`,
    `<${M} invoke name="bash">`,
    `<${M} parameter name="command" string="true">dir`,
    `<${M} parameter>`,
    `</${M} invoke>`,
    `</${M}>`,
    ' متن دوم',
  ];
  for (const c of chunks) api.handleRaw(c);
  api.finish();
  const text = emitted.join('');
  assert.ok(!text.includes('DSML'), 'chunked DSML must not leak');
  assert.ok(text.includes('متن اول'));
  assert.ok(text.includes('متن دوم'));
}

// ---- 5. two tool calls in one answer -----------------------------------
{
  const { api, emitted } = makeHook();
  api.reset('r5');
  const call = (name, arg) =>
    `<${M} calls><${M} invoke name="${name}">` +
    `<${M} parameter name="v" string="true">${arg}<${M} parameter>` +
    `</${M} invoke></${M}>`;
  api.handleRaw('شروع ');
  api.handleRaw(call('glob', '*'));
  api.handleRaw(call('read', 'x.md'));
  api.handleRaw(' پایان');
  api.finish();
  const text = emitted.join('');
  assert.ok(!text.includes('DSML'), 'DSML must be removed for every block');
  assert.strictEqual(text, 'شروع  پایان');
}

// ---- 6. no DSML at all -> nothing is lost -------------------------------
{
  const { api, emitted } = makeHook();
  api.reset('r6');
  const full = 'یک پاسخ کاملا معمولی بدون هیچ ابزاری.\nخط دوم.';
  api.handleRaw(full);
  api.finish();
  assert.strictEqual(emitted.join(''), full);
}

// ---- 7. a pure tool call emits no prose but still reports completion ----
// This is the case that must NOT fall back to DOM scraping, because the
// answer legitimately contains no visible text.
{
  const { api, emitted, posts } = makeHook();
  api.reset('r7');
  const dsml =
    `<${M} calls><${M} invoke name="get_time">` +
    `<${M} parameter name="tz" string="true">Asia/Tehran<${M} parameter>` +
    `</${M} invoke></${M}>`;
  for (const piece of [dsml]) api.handleRaw(piece);
  api.finish();
  assert.strictEqual(emitted.join(''), '', 'a pure tool call must produce no prose');
  const complete = posts.find((p) => p.kind === 'raw-complete');
  assert.ok(complete, 'completion must still be reported');
  assert.ok(complete.raw.includes('get_time'), 'raw must keep the tool name for parsing');
}

// ---- 8. SSE parsing produces chunks from the real DeepSeek wire format --
{
  const posts = [];
  const win = { postMessage: (m) => posts.push(m.payload) };
  win.window = win;
  const ctx = { console, window: win, module: { exports: {} }, XMLHttpRequest: function XHR() {}, TextDecoder };
  vm.runInNewContext(source, ctx);
  const api = ctx.module.exports;

  api.setActive('s1');
  const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
  const frames = [
    frame({ v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } }),
    frame({ p: 'response/fragments/0/content', o: 'APPEND', v: 'سلام ' }),
    frame({ p: 'response/fragments/0/content', o: 'APPEND', v: 'دنیا' }),
    frame({ o: 'BATCH', p: 'response', v: [{ p: 'status', v: 'FINISHED' }] }),
  ].join('');

  api.parseSseChunk(frames);

  const chunks = posts.filter((p) => p.kind === 'chunk').map((p) => p.delta);
  const complete = posts.find((p) => p.kind === 'raw-complete');
  assert.ok(complete, 'FINISHED must end the stream');
  assert.strictEqual(complete.raw, 'سلام دنیا');
  assert.strictEqual(chunks.join(''), 'سلام دنیا', 'text must stream incrementally');
  assert.ok(chunks.length >= 2, 'more than one chunk means real incremental streaming');
}

// ---- 9. an OpenAI-style chunk is also understood -----------------------
{
  const posts = [];
  const win = { postMessage: (m) => posts.push(m.payload) };
  win.window = win;
  const ctx = { console, window: win, module: { exports: {} }, XMLHttpRequest: function XHR() {}, TextDecoder };
  vm.runInNewContext(source, ctx);
  const api = ctx.module.exports;
  api.setActive('s2');
  api.parseSseChunk(
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: ' there' }, finish_reason: 'stop' }] })}\n\n`,
  );
  const complete = posts.find((p) => p.kind === 'raw-complete');
  assert.ok(complete);
  assert.strictEqual(complete.raw, 'hi there');
}

console.log('✅ stream hook / DSML sanitisation tests passed');