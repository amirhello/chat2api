'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
const start = source.indexOf('function messageFingerprint');
const end = source.indexOf('async function callDriver');
assert.ok(start >= 0 && end > start, 'prompt helper section not found');

const context = {
  conversationSessions: new Map(),
  comparableUrl: (value) => value || null,
  console,
};
vm.runInNewContext(
  `${source.slice(start, end)}\nthis.promptApi = { buildPrompt, commitSession };`,
  context,
);
const { buildPrompt, commitSession } = context.promptApi;

const tools = [{
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a command',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
  },
}];
const firstMessages = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'پینگ بگیر' },
];
const key = 'test-session';
const first = buildPrompt(firstMessages, tools, 'auto', key);
assert.match(first.text, /Available tools/);
assert.match(first.text, /bash/);
assert.match(first.text, /پینگ بگیر/);
commitSession(key, first);

const secondMessages = [
  ...firstMessages,
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ping"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'PING OK' },
];
const second = buildPrompt(secondMessages, tools, 'auto', key);
assert.match(second.text, /Tool result/);
assert.match(second.text, /PING OK/);
assert.doesNotMatch(second.text, /You are helpful\./);
assert.doesNotMatch(second.text, /پینگ بگیر/);
const longResult = 'x'.repeat(30_000);
const truncated = buildPrompt(
  [...firstMessages, { role: 'tool', tool_call_id: 'c2', content: longResult }],
  tools,
  'auto',
  'truncation-session',
);
assert.match(truncated.text, /Tool result truncated/);
assert.ok(truncated.text.length < 10_000, 'tool result should be truncated before page injection');
const manyTools = buildPrompt(
  firstMessages,
  Array.from({ length: 100 }, (_, i) => ({
    type: 'function',
    function: {
      name: `tool_${i}`,
      description: 'A tool '.repeat(40),
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
    },
  })),
  'auto',
  'many-tools-session',
);
assert.match(manyTools.text, /emit a DSML block/);
assert.ok(manyTools.text.length <= 6200, 'tool manifest should respect its cap');
const noTools = buildPrompt(firstMessages, tools, 'none', 'no-tools-session');
assert.doesNotMatch(noTools.text, /tool protocol/i);
console.log('✅ tool prompt/session tests passed');
