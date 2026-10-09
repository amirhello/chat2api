'use strict';

const assert = require('assert');
const { normalizeChatUrl, resolveSite } = require('../bridge/config');

const validUrl = 'https://chat.deepseek.com/a/chat/s/00000000-0000-4000-8000-000000000000#fragment';
assert.strictEqual(
  normalizeChatUrl(validUrl),
  'https://chat.deepseek.com/a/chat/s/00000000-0000-4000-8000-000000000000',
);

assert.strictEqual(
  normalizeChatUrl('https://chat.deepseek.com/'),
  'https://chat.deepseek.com/',
);
assert.strictEqual(normalizeChatUrl(''), null);
assert.throws(() => normalizeChatUrl('http://chat.deepseek.com/'));
assert.throws(() => normalizeChatUrl('https://example.com/'));
assert.throws(() => normalizeChatUrl('https://chat.deepseek.com.evil.test/'));
assert.throws(() => normalizeChatUrl('https://chat.deepseek.com:8443/'));
assert.throws(() => normalizeChatUrl('https://user:pass@chat.deepseek.com/'));

assert.strictEqual(resolveSite('deepseek'), 'deepseek');
assert.strictEqual(resolveSite('ds'), 'deepseek');
assert.strictEqual(resolveSite('chat-bridge/deepseek'), 'deepseek');
assert.strictEqual(resolveSite('gpt-4o'), null);
assert.strictEqual(resolveSite('unknown'), null);

console.log('✅ target URL/model validation tests passed');
