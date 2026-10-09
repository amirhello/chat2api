'use strict';

/**
 * Tests for extension/content/dsml-parser.js — no external dependencies.
 *
 *   node tools/test-dsml-parser.js
 */

const assert = require('assert');
const path = require('path');

const parser = require(path.join(__dirname, '..', 'extension', 'content', 'dsml-parser.js'));

// The DSML delimiter is U+FF5C FULLWIDTH VERTICAL LINE; kept escaped so the
// source file stays readable and ASCII-safe.
const BAR = '\uff5c';

function tag(keyword, attrs) {
  let out = '<' + BAR + BAR + 'DSML' + BAR + BAR;
  if (keyword) out += ' ' + keyword;
  if (attrs) out += ' ' + attrs;
  return out + '>';
}

function close(keyword) {
  return '</' + BAR + BAR + 'DSML' + BAR + BAR + (keyword ? ' ' + keyword : '') + '>';
}

function stringParam(key, value) {
  return tag('parameter', 'name="' + key + '"') + tag('string') + value + close('string') + close('parameter');
}

function invoke(name, body) {
  return tag('invoke', name ? 'name="' + name + '"' : null) + (body || '') + close('invoke');
}

function calls(inner) {
  return tag('calls') + inner + close();
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ----- plain text -----

test('plain text is returned untouched', () => {
  const result = parser.parseToolCalls('Just a normal answer.');
  assert.deepStrictEqual(result, {
    text: 'Just a normal answer.',
    toolCalls: [],
    hasToolCalls: false,
  });
});

test('plain text keeps its original whitespace', () => {
  const result = parser.parseToolCalls('  spaced\tout\n\n');
  assert.strictEqual(result.text, '  spaced\tout\n\n');
  assert.strictEqual(result.hasToolCalls, false);
});

test('non-string and empty inputs never throw', () => {
  for (const input of [null, undefined, '', 0, 42, {}, []]) {
    const result = parser.parseToolCalls(input);
    assert.strictEqual(typeof result.text, 'string');
    assert.ok(Array.isArray(result.toolCalls));
    assert.strictEqual(result.hasToolCalls, false);
  }
  assert.strictEqual(parser.parseToolCalls(null).text, '');
});

// ----- single call -----

test('single call with string parameters', () => {
  const body = invoke('get_weather', stringParam('location', 'Tehran') + stringParam('days', '3'));
  const raw = calls(body);
  const result = parser.parseToolCalls(raw);
  assert.strictEqual(result.hasToolCalls, true);
  assert.strictEqual(result.text, '');
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, 'get_weather');
  assert.deepStrictEqual(result.toolCalls[0].arguments, { location: 'Tehran', days: '3' });
  assert.strictEqual(result.toolCalls[0].raw, body);
});

test('bare invoke without a calls wrapper still parses', () => {
  const body = invoke('ping', stringParam('msg', 'pong'));
  const result = parser.parseToolCalls(body);
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, 'ping');
  assert.deepStrictEqual(result.toolCalls[0].arguments, { msg: 'pong' });
});

test('function_call alias is supported', () => {
  const body = tag('function_call', 'name="run"') + stringParam('cmd', 'ls -la') + close();
  const text = tag('function_calls') + body + close();
  const result = parser.parseToolCalls(text);
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, 'run');
  assert.deepStrictEqual(result.toolCalls[0].arguments, { cmd: 'ls -la' });
});

// ----- multiple calls -----

test('multiple invokes in one block keep document order', () => {
  const text = calls(invoke('first', stringParam('a', '1')) + invoke('second', stringParam('b', '2')));
  const result = parser.parseToolCalls(text);
  assert.strictEqual(result.toolCalls.length, 2);
  assert.deepStrictEqual(result.toolCalls.map((c) => c.name), ['first', 'second']);
  assert.deepStrictEqual(result.toolCalls[0].arguments, { a: '1' });
  assert.deepStrictEqual(result.toolCalls[1].arguments, { b: '2' });
  assert.strictEqual(result.text, '');
});

test('multiple separate blocks are all collected', () => {
  const text = calls(invoke('one')) + '\ntext\n' + calls(invoke('two'));
  const result = parser.parseToolCalls(text);
  assert.deepStrictEqual(result.toolCalls.map((c) => c.name), ['one', 'two']);
  assert.strictEqual(result.text, 'text');
});

test('repeated parameter names collapse into an array', () => {
  const result = parser.parseToolCalls(calls(invoke('list', stringParam('tag', 'a') + stringParam('tag', 'b'))));
  assert.deepStrictEqual(result.toolCalls[0].arguments, { tag: ['a', 'b'] });
});

// ----- mixed text -----

test('prose around a call block is preserved', () => {
  const text = 'Let me check that.\n' + calls(invoke('get_weather', stringParam('city', 'Tehran'))) + '\nOne moment.';
  const result = parser.parseToolCalls(text);
  assert.strictEqual(result.text, 'Let me check that.\n\nOne moment.');
  assert.strictEqual(result.hasToolCalls, true);
  assert.strictEqual(result.toolCalls[0].name, 'get_weather');
});

test('prose inside the call block is not leaked into the text', () => {
  const text = 'Before.' + calls(invoke('f', stringParam('p', 'v')) + 'chatter') + 'After.';
  const result = parser.parseToolCalls(text);
  assert.strictEqual(result.text, 'Before.After.');
});

test('CRLF responses are normalized', () => {
  const text = 'Line one\r\n' + calls(invoke('f')) + '\r\n\r\nLine two';
  assert.strictEqual(parser.parseToolCalls(text).text, 'Line one\n\nLine two');
});

test('unknown DSML tags are transparent, not fatal', () => {
  const text = 'visible' + tag('unknown_thing') + 'also visible' + close('unknown_thing');
  const result = parser.parseToolCalls(text);
  assert.strictEqual(result.text, 'visiblealso visible');
  assert.strictEqual(result.hasToolCalls, false);
});

test('a keyword-less block is transparent', () => {
  const result = parser.parseToolCalls(tag() + 'junk' + close());
  assert.strictEqual(result.text, 'junk');
  assert.strictEqual(result.hasToolCalls, false);
});

// ----- arguments JSON -----

test('arguments JSON in an attribute is parsed', () => {
  const body = tag('invoke', 'name="search" arguments=\'{"q":"cats","limit":5}\'') + close('invoke');
  const result = parser.parseToolCalls(calls(body));
  assert.deepStrictEqual(result.toolCalls[0].arguments, { q: 'cats', limit: 5 });
});

test('html-escaped arguments JSON is decoded then parsed', () => {
  const body = tag('invoke', 'name="search" arguments="{&quot;q&quot;:&quot;cats&quot;}"') + close('invoke');
  const result = parser.parseToolCalls(calls(body));
  assert.deepStrictEqual(result.toolCalls[0].arguments, { q: 'cats' });
});

test('JSON containing > inside an attribute is preserved', () => {
  const body = tag('invoke', 'name="cmp" arguments=\'{"expr":"a>b"}\'') + close('invoke');
  const result = parser.parseToolCalls(calls(body));
  assert.deepStrictEqual(result.toolCalls[0].arguments, { expr: 'a>b' });
});

test('name attribute carrying a whole JSON spec is unpacked', () => {
  const body = tag('invoke', 'name=\'{"name":"lookup","arguments":{"id":42}}\'') + close('invoke');
  const result = parser.parseToolCalls(calls(body));
  assert.strictEqual(result.toolCalls[0].name, 'lookup');
  assert.deepStrictEqual(result.toolCalls[0].arguments, { id: 42 });
});

test('json parameter block is parsed, not stringified', () => {
  const body = tag('parameter', 'name="opts"') + tag('json') + '{"deep":true,"n":[1,2]}' + close('json') + close('parameter');
  const result = parser.parseToolCalls(calls(invoke('cfg', body)));
  assert.deepStrictEqual(result.toolCalls[0].arguments, { opts: { deep: true, n: [1, 2] } });
});

test('invalid json block falls back to its raw text', () => {
  const body = tag('parameter', 'name="opts"') + tag('json') + '{not json}' + close('json') + close('parameter');
  const result = parser.parseToolCalls(calls(invoke('cfg', body)));
  assert.deepStrictEqual(result.toolCalls[0].arguments, { opts: '{not json}' });
});

test('raw JSON invoke body becomes the arguments', () => {
  const body = tag('invoke', 'name="t"') + '{"k":[1,2]}' + close('invoke');
  const result = parser.parseToolCalls(calls(body));
  assert.deepStrictEqual(result.toolCalls[0].arguments, { k: [1, 2] });
});

test('non-object invoke body yields empty arguments', () => {
  const result = parser.parseToolCalls(calls(tag('invoke', 'name="t"') + 'just prose' + close('invoke')));
  assert.deepStrictEqual(result.toolCalls[0].arguments, {});
});

test('unnamed parameter holding a JSON object merges into arguments', () => {
  const result = parser.parseToolCalls(calls(invoke('t', tag('json') + '{"a":1,"b":2}' + close('json'))));
  assert.deepStrictEqual(result.toolCalls[0].arguments, { a: 1, b: 2 });
});

test('attribute JSON and parameters both contribute', () => {
  const body = tag('invoke', 'name="t" arguments=\'{"a":1}\'') + stringParam('b', '2') + close('invoke');
  const result = parser.parseToolCalls(calls(body));
  assert.deepStrictEqual(result.toolCalls[0].arguments, { a: 1, b: '2' });
});

test('a key coming from both the attribute and a parameter becomes an array', () => {
  const body = tag('invoke', 'name="t" arguments=\'{"a":1}\'') + stringParam('a', '2') + close('invoke');
  const result = parser.parseToolCalls(calls(body));
  assert.deepStrictEqual(result.toolCalls[0].arguments, { a: [1, '2'] });
});

test('special characters survive in parameter values', () => {
  const value = 'He said "hi" &amp; left > 3';
  const result = parser.parseToolCalls(calls(invoke('f', stringParam('q', value))));
  assert.deepStrictEqual(result.toolCalls[0].arguments, { q: value });
});

test('values keep their internal newlines', () => {
  const result = parser.parseToolCalls(calls(invoke('f', stringParam('q', 'line1\nline2'))));
  assert.deepStrictEqual(result.toolCalls[0].arguments, { q: 'line1\nline2' });
});

test('a call with no parameters has empty arguments', () => {
  const result = parser.parseToolCalls(calls(invoke('now')));
  assert.deepStrictEqual(result.toolCalls[0].arguments, {});
  assert.strictEqual(result.toolCalls[0].name, 'now');
});

// ----- malformed / incomplete -----

test('invoke without a name does not throw', () => {
  const body = tag('invoke') + stringParam('a', '1') + close('invoke');
  const result = parser.parseToolCalls(calls(body));
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, '');
  assert.deepStrictEqual(result.toolCalls[0].arguments, { a: '1' });
});

test('unterminated invoke at end of stream still yields a call', () => {
  const text = 'Thinking... ' + tag('calls') + tag('invoke', 'name="get_weather"');
  const result = parser.parseToolCalls(text);
  assert.strictEqual(result.text, 'Thinking...');
  assert.strictEqual(result.hasToolCalls, true);
  assert.strictEqual(result.toolCalls[0].name, 'get_weather');
  assert.deepStrictEqual(result.toolCalls[0].arguments, {});
});

test('unterminated string keeps its partial value', () => {
  const text = tag('calls') + invoke('f', tag('parameter', 'name="p"') + tag('string') + 'half');
  const result = parser.parseToolCalls(text);
  assert.deepStrictEqual(result.toolCalls[0].arguments, { p: 'half' });
});

test('unterminated block after a complete call keeps the call', () => {
  const text = calls(invoke('done')) + tag('calls') + invoke('partial');
  const result = parser.parseToolCalls(text);
  assert.deepStrictEqual(result.toolCalls.map((c) => c.name), ['done', 'partial']);
  assert.strictEqual(result.text, '');
});

test('tag without a closing bracket is not fatal', () => {
  const text = 'Broken ' + '<' + BAR + BAR + 'DSML' + BAR + BAR + ' invoke name="x"';
  const result = parser.parseToolCalls(text);
  assert.strictEqual(result.hasToolCalls, false);
  assert.deepStrictEqual(result.toolCalls, []);
  assert.ok(result.text.indexOf('Broken') === 0);
});

test('empty and stray DSML blocks are harmless', () => {
  for (const text of [tag('calls') + close(), tag() + close(), close(), close('invoke') + close()]) {
    const result = parser.parseToolCalls(text);
    assert.strictEqual(result.hasToolCalls, false);
    assert.strictEqual(result.text, '');
  }
});

test('self-closing invoke is supported', () => {
  const result = parser.parseToolCalls(calls(tag('invoke', 'name="noop"') + '/>'));
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, 'noop');
});

test('malformed input never throws', () => {
  const broken = [
    '<｜｜DSML｜｜ calls>',
    '</｜｜DSML｜｜>',
    '<' + BAR + BAR + 'DSML' + BAR + BAR + ' invoke name="unclosed',
    tag('calls') + tag('invoke', 'name="a"') + tag('parameter') + tag('string'),
    '<<>>' + tag('calls'),
    tag('calls') + '</｜｜DSML｜｜ invoke>' + tag('invoke', 'name="b"') + close('invoke'),
    'a' + BAR + BAR + 'DSML' + BAR + BAR + 'invoke name="c"' + tag('string') + 'x',
    tag('invoke', 'name="') + close('invoke'),
    tag('invoke', 'arguments="{bad json}"'),
  ];
  for (const text of broken) {
    assert.doesNotThrow(() => parser.parseToolCalls(text), 'threw on: ' + JSON.stringify(text));
  }
});

test('deeply nested markup is handled without throwing', () => {
  let text = invoke('leaf', stringParam('a', 'v'));
  for (let i = 0; i < 40; i++) text = calls(text);
  const result = parser.parseToolCalls(text);
  assert.strictEqual(result.hasToolCalls, true);
  assert.strictEqual(result.toolCalls.length, 1);
  assert.strictEqual(result.toolCalls[0].name, 'leaf');
  assert.deepStrictEqual(result.toolCalls[0].arguments, { a: 'v' });
  assert.strictEqual(result.text, '');
});

// ----- helpers -----

test('sanitizeText strips DSML and keeps prose', () => {
  const text = 'Here you go.\n' + calls(invoke('f', stringParam('a', '1')));
  assert.strictEqual(parser.sanitizeText(text), 'Here you go.');
  assert.strictEqual(parser.stripDsml(text), 'Here you go.');
  assert.strictEqual(parser.sanitizeText('no dsml here'), 'no dsml here');
  assert.strictEqual(parser.sanitizeText(null), '');
});

test('hasDsml and hasToolCalls', () => {
  assert.strictEqual(parser.hasDsml('plain'), false);
  assert.strictEqual(parser.hasDsml(calls(invoke('f'))), true);
  assert.strictEqual(parser.hasDsml(tag('calls') + 'truncated'), true);
  assert.strictEqual(parser.hasToolCalls('plain'), false);
  assert.strictEqual(parser.hasToolCalls(calls(invoke('f'))), true);
  assert.strictEqual(parser.hasToolCalls(tag('calls') + tag('invoke', 'name="f"')), true);
});

test('parseArguments is a safe JSON parser', () => {
  assert.deepStrictEqual(parser.parseArguments('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(parser.parseArguments('  {"a":[1,2]},  '), { a: [1, 2] });
  assert.deepStrictEqual(parser.parseArguments('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(parser.parseArguments('[1,2]'), [1, 2]);
  assert.strictEqual(parser.parseArguments('nope'), undefined);
  assert.strictEqual(parser.parseArguments(''), undefined);
  assert.strictEqual(parser.parseArguments(null), undefined);
});

test('the module is usable from Node and as a global', () => {
  assert.strictEqual(typeof parser.parseToolCalls, 'function');
  assert.strictEqual(typeof globalThis.ChatBridgeDsmlParser, 'object');
  assert.strictEqual(globalThis.ChatBridgeDsmlParser.parseToolCalls, parser.parseToolCalls);
});

// ----- runner -----

let passed = 0;
const failures = [];
for (const item of tests) {
  try {
    item.fn();
    passed++;
    process.stdout.write('  ok  ' + item.name + '\n');
  } catch (err) {
    failures.push({ name: item.name, err });
    process.stdout.write('FAIL  ' + item.name + '\n');
  }
}

process.stdout.write('\n' + passed + '/' + tests.length + ' tests passed\n');
if (failures.length) {
  for (const failure of failures) {
    process.stdout.write('\n--- ' + failure.name + '\n');
    process.stdout.write(String(failure.err && failure.err.stack ? failure.err.stack : failure.err) + '\n');
  }
  process.exitCode = 1;
}
