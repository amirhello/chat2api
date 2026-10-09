'use strict';

/* global module, globalThis */

/**
 * DOM helpers shared by the DeepSeek content driver and Node-based tests.
 * The generic fallback anchors on the exact prompt text, then reads the next
 * visible message sibling. This keeps response detection working when
 * DeepSeek changes hashed CSS class names.
 */
(function initChatBridgeDomResponse(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatBridgeDomResponse = api;
})(typeof globalThis === 'object' ? globalThis : this, function createChatBridgeDomResponse() {
  const USER_SELECTOR = [
    '[data-message-author-role="user"]',
    '[class*="user-message"]',
    '[class*="user_message"]',
    '.ds-user-message',
    'div',
    'article',
    'section',
    'p',
  ].join(', ');

  function textOf(element) {
    if (!element) return '';
    const value = element.innerText ?? element.textContent ?? '';
    return String(value).trim();
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(element) {
    if (!element) return false;
    if (typeof element.getClientRects === 'function' && element.getClientRects().length > 0) return true;
    return element.offsetParent !== null && element.offsetParent !== undefined;
  }

  function classNameOf(element) {
    const value = typeof element.className === 'string' ? element.className : '';
    return value;
  }

  function isComposer(element) {
    const tag = String(element.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input' || tag === 'button') return true;
    if (typeof element.querySelector !== 'function') return false;
    return !!(
      element.querySelector('textarea')
      || element.querySelector('[contenteditable="true"]')
      || element.querySelector('input')
    );
  }

  function contains(root, candidate) {
    if (root === candidate) return true;
    if (typeof root.contains === 'function') return root.contains(candidate);
    return false;
  }

  function similarToPrompt(text, prompt) {
    if (text === prompt) return true;
    if (prompt.length < 8) return false;
    const words = prompt.split(' ').filter((word) => word.length > 1);
    if (words.length === 0) return false;
    const matched = words.filter((word) => text.includes(word)).length;
    return matched / words.length >= 0.6;
  }

  function userMarkerScore(element) {
    const marker = `${classNameOf(element)} ${element.getAttribute?.('data-message-author-role') || ''}`;
    return /user|user-message|user_message/i.test(marker) ? -100000 : 0;
  }

  function findUserNode(doc, promptText) {
    const needle = normalizeText(promptText);
    if (!needle || !doc?.querySelectorAll) return null;
    const nodes = [...doc.querySelectorAll(USER_SELECTOR)];
    let exact = null;
    let approximate = null;
    let approximateScore = Number.POSITIVE_INFINITY;
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const text = normalizeText(textOf(node));
      if (text === needle) {
        exact = node;
        continue;
      }
      const score = userMarkerScore(node) + text.length;
      if (score < approximateScore && text.length <= needle.length * 2 + 500
        && similarToPrompt(text, needle)) {
        approximate = node;
        approximateScore = score;
      }
    }
    return exact || approximate;
  }

  function findGenericResponse(doc, promptText, knownUserNode = null) {
    const prompt = normalizeText(promptText);
    const userNode = knownUserNode && normalizeText(textOf(knownUserNode)) === prompt
      ? knownUserNode
      : findUserNode(doc, prompt);
    if (!userNode) return null;

    // Climb to the outer edge of the user bubble so a label/timestamp inside
    // that bubble cannot be mistaken for the assistant response.
    let current = userNode;
    while (current.parentElement) {
      const parentText = normalizeText(textOf(current.parentElement));
      const looksLikeUserContainer = parentText === prompt;
      if (!looksLikeUserContainer) break;
      current = current.parentElement;
    }
    for (let depth = 0; depth < 8; depth += 1) {
      const parent = current?.parentElement;
      if (!parent) break;
      const children = [...(parent.children || [])].filter(isVisible);
      const index = children.findIndex((child) => contains(child, current));
      if (index >= 0) {
        for (const sibling of children.slice(index + 1)) {
          const text = textOf(sibling);
          if (!text || normalizeText(text) === prompt || isComposer(sibling)) continue;
          return { node: sibling, text, depth, userNode };
        }
      }
      current = parent;
    }

    return null;
  }

  function looksLikeResponse(element) {
    const marker = `${classNameOf(element)} ${element.getAttribute?.('data-message-author-role') || ''}`;
    return /assistant|answer|response|markdown|prose|message-content|message_content/i.test(marker);
  }

  function snapshot(doc) {
    const values = new Map();
    if (!doc?.querySelectorAll) return values;
    for (const node of doc.querySelectorAll('div, article, section, p, span, [data-message-author-role]')) {
      if (isVisible(node)) values.set(node, normalizeText(textOf(node)));
    }
    return values;
  }

  function findChangedResponse(doc, before, promptText) {
    if (!doc?.querySelectorAll || !before) return null;
    const prompt = normalizeText(promptText);
    const candidates = [];
    for (const node of doc.querySelectorAll('div, article, section, p, span, [data-message-author-role]')) {
      if (!isVisible(node) || isComposer(node)) continue;
      const text = normalizeText(textOf(node));
      if (text.length < 2 || text === prompt) continue;
      if (before.get(node) === text) continue;
      const score = (looksLikeResponse(node) ? 100000 : 0) + text.length;
      candidates.push({ node, text, score });
    }
    candidates.sort((a, b) => a.score - b.score);
    return candidates[candidates.length - 1] || null;
  }

  return {
    findChangedResponse,
    findGenericResponse,
    findUserNode,
    isVisible,
    looksLikeResponse,
    snapshot,
    textOf,
  };
});
