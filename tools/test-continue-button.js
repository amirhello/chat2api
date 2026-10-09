'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content', 'driver.js'), 'utf8');
const start = source.indexOf('function inputIsUsable');
const end = source.indexOf('function pressEnter');
assert.ok(start >= 0 && end > start, 'driver button helper section not found');

const context = {
  document: { querySelectorAll: () => [] },
  console,
  chrome: { runtime: { sendMessage() {} } },
  sleep: () => Promise.resolve(),
  logToBackground() {},
  throwIfAborted() {},
};
vm.runInNewContext(`${source.slice(start, end)}\nthis.api = { findContinueButton };`, context);
const { findContinueButton } = context.api;

function element({ text = '', className = '', visible = true, disabled = false, aria = '' } = {}) {
  return {
    tagName: 'DIV',
    className,
    innerText: text,
    textContent: text,
    disabled,
    getAttribute: (name) => (name === 'aria-label' ? aria : null),
    getClientRects: () => (visible ? [{}] : []),
    offsetParent: visible ? {} : null,
    querySelector: () => null,
  };
}

const first = element({ text: 'Continue', visible: false });
const send = element({ text: '', className: 'ds-button--primary ds-button--circle ds-button--filled' });
const last = element({ text: 'Continue' });
context.document.querySelectorAll = () => [first, send, last];
assert.strictEqual(findContinueButton(), last, 'the last visible Continue button should win');

const arabic = element({ text: 'ادامه' });
context.document.querySelectorAll = () => [arabic];
assert.strictEqual(findContinueButton(), arabic);

console.log('✅ continue-button tests passed');
