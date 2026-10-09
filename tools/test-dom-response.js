'use strict';

const assert = require('assert');
const {
  findChangedResponse,
  findGenericResponse,
  findUserNode,
  snapshot,
} = require('../extension/content/dom-response.js');

class FakeElement {
  constructor(tagName, text = '', { className = '', visible = true, attrs = {} } = {}) {
    this.tagName = tagName.toUpperCase();
    this.className = className;
    this.attrs = attrs;
    this.visible = visible;
    this.ownText = text;
    this.children = [];
    this.parentElement = null;
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  get innerText() {
    if (this.children.length === 0) return this.ownText;
    return [this.ownText, ...this.children.map((child) => child.innerText)]
      .filter(Boolean)
      .join('\n');
  }

  get offsetParent() {
    return this.visible ? {} : null;
  }

  getClientRects() {
    return this.visible ? [{}] : [];
  }

  getAttribute(name) {
    return this.attrs[name] || null;
  }

  descendants() {
    const out = [];
    for (const child of this.children) {
      out.push(child, ...child.descendants());
    }
    return out;
  }

  contains(node) {
    if (this === node) return true;
    return this.descendants().includes(node);
  }

  querySelector(selector) {
    const wantedTag = selector.startsWith('input') ? 'INPUT'
      : selector.startsWith('textarea') ? 'TEXTAREA'
        : null;
    return this.descendants().find((node) => (
      wantedTag ? node.tagName === wantedTag : node.getAttribute('contenteditable') === 'true'
    )) || null;
  }
}

class FakeDocument {
  constructor(body) {
    this.body = body;
  }

  querySelectorAll() {
    return [this.body, ...this.body.descendants()];
  }
}

function conversation({ assistantClass = 'a1b2c3' } = {}) {
  const prompt = 'سلام، این پیام تست است.';
  const user = new FakeElement('div', prompt, { className: 'hashed-user' });
  const assistant = new FakeElement('div', 'پاسخ کامل DeepSeek', { className: assistantClass });
  const composer = new FakeElement('div', '', { className: 'composer' });
  composer.append(new FakeElement('textarea', ''));
  const root = new FakeElement('div', '', { className: 'chat-root' });
  root.append(user, assistant, composer);
  return { doc: new FakeDocument(root), user, assistant, root, prompt };
}

{
  const { doc, user, prompt } = conversation();
  assert.strictEqual(findUserNode(doc, prompt), user);
  const result = findGenericResponse(doc, prompt);
  assert.ok(result, 'generic response was not found');
  assert.strictEqual(result.text, 'پاسخ کامل DeepSeek');
}

{
  const { doc, user, assistant, prompt } = conversation();
  const cached = user;
  assistant.ownText = 'پاسخ به‌روزشده';
  const result = findGenericResponse(doc, prompt, cached);
  assert.strictEqual(result.text, 'پاسخ به‌روزشده');
}

{
  const root = new FakeElement('div', '', { className: 'chat-root' });
  const nested = new FakeElement('div', '', { className: 'bubble' });
  nested.append(new FakeElement('p', 'پیام کاربر', { className: 'user-bubble' }));
  const answer = new FakeElement('div', 'پاسخ', { className: 'server-bubble' });
  root.append(nested, answer);
  const doc = new FakeDocument(root);
  const result = findGenericResponse(doc, 'پیام کاربر');
  assert.strictEqual(result.text, 'پاسخ');
}

{
  const { doc, prompt } = conversation();
  assert.strictEqual(findGenericResponse(doc, 'متنی که در صفحه نیست'), null);
}

{
  const prompt = 'این یک پیام طولانی است که باید بعد از این بخش با **مارک‌داون** در صفحه نمایش داده شود.';
  const user = new FakeElement('div', 'این یک پیام طولانی است که باید بعد از این بخش با مارک‌داون در صفحه نمایش داده شود.', { className: 'user-bubble' });
  const answer = new FakeElement('div', 'پاسخ', { className: 'assistant' });
  const root = new FakeElement('div', '', { className: 'chat-root' }).append(user, answer);
  const doc = new FakeDocument(root);
  assert.ok(findGenericResponse(doc, prompt), 'approximate/whitespace user match failed');
}

{
  const root = new FakeElement('div', '', { className: 'chat-root' });
  const user = new FakeElement('div', 'پیام کاربر', { className: 'user-bubble' });
  const answer = new FakeElement('div', 'شروع پاسخ', { className: 'assistant' });
  root.append(user, answer);
  const doc = new FakeDocument(root);
  const before = snapshot(doc);
  answer.ownText = 'پاسخ کامل که بعد از ارسال تغییر کرد';
  const changed = findChangedResponse(doc, before, 'پیام کاربر');
  assert.strictEqual(changed.text, 'پاسخ کامل که بعد از ارسال تغییر کرد');
}

console.log('✅ generic DOM response tests passed');
