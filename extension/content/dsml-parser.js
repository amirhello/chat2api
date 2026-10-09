'use strict';

/* global module, globalThis */

/**
 * DSML tool-call parser for DeepSeek responses.
 *
 * DeepSeek wraps tool calls in a DSML control-tag dialect instead of emitting
 * bare JSON, for example:
 *
 *   Let me check that for you.
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="get_weather">
 *   <｜｜DSML｜｜ parameter name="location"><｜｜DSML｜｜ string>Tehran<｜｜DSML｜｜></｜｜DSML｜｜ parameter>
 *   <｜｜DSML｜｜ parameter name="days"><｜｜DSML｜｜ string>3<｜｜DSML｜｜></｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜>
 *
 * The parser is deliberately tolerant: streaming responses are cut off in the
 * middle of a block, models invent tags, and a block may arrive with no
 * wrapper at all. It never throws — anything it cannot understand is dropped
 * from the visible text, and everything it does understand is reported
 * through `toolCalls`.
 *
 * Loadable as a plain <script> in the content script and via require() in Node.
 */
(function initChatBridgeDsmlParser(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChatBridgeDsmlParser = api;
})(typeof globalThis === 'object' ? globalThis : this, function createChatBridgeDsmlParser() {
  // <｜｜DSML｜｜ keyword attr="value"> — tolerant of whitespace, casing, the
  // halfwidth `|`, a missing space before the keyword and quoted values that
  // themselves contain `>`.
  const DSML_TAG_RE = /<\s*(\/?)\s*[|｜]{2}\s*dsml\s*[|｜]{2}\s*((?:[^>"']|"[^"]*"|'[^']*')*?)>/gi;
  const DSML_PRESENT_RE = /<\s*\/?\s*[|｜]{2}\s*dsml\s*[|｜]{2}/i;
  const ATTR_RE = /([A-Za-z_][A-Za-z0-9_:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`<>]+)))?/g;
  const KEYWORD_RE = /^([A-Za-z_][A-Za-z0-9_.-]*)?/;
  const LEADING_JSON_RE = /^[{[]/;

  // Keywords, lowercased. A block is a container for calls, an invoke is one
  // call, a parameter wraps a single argument value.
  const BLOCK_KEYWORDS = new Set([
    'calls', 'tool_calls', 'functions', 'function_calls', 'functions_call',
  ]);
  const INVOKE_KEYWORDS = new Set([
    'invoke', 'invokes', 'function_call', 'functioncall', 'tool_call', 'call_tool', 'call',
  ]);
  const PARAM_KEYWORDS = new Set([
    'parameter', 'parameters', 'param', 'argument', 'arguments', 'arg', 'input', 'key_value',
  ]);
  const STRING_KEYWORDS = new Set(['string', 'text', 'content']);
  const JSON_KEYWORDS = new Set(['json', 'json_object', 'data', 'payload']);
  const NAME_ATTRS = ['name', 'tool', 'tool_name', 'toolname', 'function', 'fn'];
  const PARAM_NAME_ATTRS = ['name', 'key', 'id', 'field', 'param', 'parameter'];
  const ARGS_ATTRS = ['arguments', 'args', 'params', 'parameters', 'input', 'payload'];
  const SPEC_ARGS_ATTRS = ['arguments', 'args', 'params', 'parameters', 'input'];

  // ----- primitive helpers -----

  function toText(value) {
    if (value == null) return '';
    return typeof value === 'string' ? value : String(value);
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function decodeEntities(value) {
    return String(value)
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&');
  }

  /**
   * JSON.parse that survives trailing junk such as `{"a":1},` or a stray
   * code fence. Returns undefined instead of throwing.
   */
  function parseArguments(value) {
    const src = toText(value).trim();
    if (!src) return undefined;
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(src);
    const body = fenced ? fenced[1] : src;
    const attempts = [body];
    const lastClose = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    if (lastClose > 0) attempts.push(body.slice(0, lastClose + 1));
    for (let i = 0; i < attempts.length; i++) {
      try {
        return JSON.parse(attempts[i]);
      } catch (err) {
        /* try the next, shorter shape */
      }
    }
    return undefined;
  }

  function parseAttributes(text) {
    const attrs = {};
    const src = toText(text);
    if (!src) return attrs;
    let match;
    ATTR_RE.lastIndex = 0;
    while ((match = ATTR_RE.exec(src)) !== null) {
      let value = match[2];
      if (value === undefined) value = match[3];
      if (value === undefined) value = match[4];
      if (value === undefined) value = '';
      attrs[match[1].toLowerCase()] = decodeEntities(value);
    }
    return attrs;
  }

  function splitKeyword(inner) {
    const src = toText(inner);
    const match = KEYWORD_RE.exec(src);
    const keyword = match && match[1] ? match[1].toLowerCase() : '';
    return { keyword, rest: src.slice(match && match[1] ? match[1].length : 0) };
  }

  function firstAttr(node, keys) {
    for (let i = 0; i < keys.length; i++) {
      const value = node.attrs[keys[i]];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return '';
  }

  // ----- tolerant tag tree -----

  function appendText(stack, value) {
    if (!value) return;
    stack[stack.length - 1].children.push({ type: 'text', value });
  }

  function closeNode(stack, keyword, endIndex) {
    if (!stack.length) return;
    // `</｜｜DSML｜｜>` with no keyword is the generic block end: it closes
    // everything still open, which is what truncated output needs.
    if (!keyword) {
      stack.length = 1;
      return;
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].keyword === keyword) {
        stack[i].close = endIndex;
        stack.length = i;
        return;
      }
    }
    // Stray close tag for something never opened: ignore it.
  }

  /**
   * Builds a forgiving tree of every DSML tag found in `text`. Unterminated
   * tags simply stay open until the end of the string, so their content is
   * still reachable.
   */
  function parseTree(text) {
    const src = toText(text);
    const root = { type: 'tag', keyword: '', attrs: {}, children: [], open: 0, close: src.length };
    const stack = [root];
    let cursor = 0;
    let match;
    DSML_TAG_RE.lastIndex = 0;
    while ((match = DSML_TAG_RE.exec(src)) !== null) {
      if (match.index > cursor) appendText(stack, src.slice(cursor, match.index));
      cursor = DSML_TAG_RE.lastIndex;
      const inner = match[2] || '';
      const selfClosing = /\/\s*$/.test(inner);
      const head = selfClosing ? inner.replace(/\/\s*$/, '') : inner;
      const parts = splitKeyword(head);
      if (match[1] === '/') {
        closeNode(stack, parts.keyword, cursor);
        continue;
      }
      const node = {
        type: 'tag',
        keyword: parts.keyword,
        attrs: parseAttributes(parts.rest),
        children: [],
        open: match.index,
        close: -1,
      };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
    }
    if (cursor < src.length) appendText(stack, src.slice(cursor));
    return root;
  }

  function walk(nodes, visit) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.type === 'text') continue;
      visit(node);
      walk(node.children, visit);
    }
  }

  function tagChildren(node) {
    const out = [];
    for (let i = 0; i < node.children.length; i++) {
      if (node.children[i].type === 'tag') out.push(node.children[i]);
    }
    return out;
  }

  function collectText(node) {
    let out = '';
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      out += child.type === 'text' ? child.value : collectText(child);
    }
    return out;
  }

  function directText(node) {
    let out = '';
    for (let i = 0; i < node.children.length; i++) {
      if (node.children[i].type === 'text') out += node.children[i].value;
    }
    return out;
  }

  function rawOf(node, src) {
    return node.close >= node.open ? src.slice(node.open, node.close) : src.slice(node.open);
  }

  // ----- argument assembly -----

  function assignValue(target, key, value) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = value;
      return;
    }
    const current = target[key];
    if (Array.isArray(current)) current.push(value);
    else target[key] = [current, value];
  }

  function assignAll(target, source) {
    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) assignValue(target, key, source[key]);
    }
  }

  function assignFromJsonTag(args, node, key) {
    const body = collectText(node);
    const parsed = parseArguments(body);
    if (!key) {
      // An unnamed JSON payload is the argument object itself.
      if (isPlainObject(parsed)) {
        assignAll(args, parsed);
        return;
      }
      assignValue(args, 'value', parsed === undefined ? body.trim() : parsed);
      return;
    }
    assignValue(args, key, parsed === undefined ? body.trim() : parsed);
  }

  function assignFromParam(args, node) {
    const key = firstAttr(node, PARAM_NAME_ATTRS);
    const parts = tagChildren(node);
    if (!key) {
      const body = collectText(node);
      const parsed = parseArguments(body);
      // An unnamed parameter holding an object is a JSON argument body.
      if (isPlainObject(parsed)) {
        assignAll(args, parsed);
        return;
      }
    }
    if (!parts.length) {
      assignValue(args, key || 'value', collectText(node).trim());
      return;
    }
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const partKey = key || firstAttr(part, PARAM_NAME_ATTRS);
      if (JSON_KEYWORDS.has(part.keyword)) {
        assignFromJsonTag(args, part, partKey);
      } else {
        assignValue(args, partKey || 'value', collectText(part).trim());
      }
    }
  }

  /**
   * A spec is a whole `{name, arguments}` object hidden either in the name
   * attribute or in the invoke body. A body that is a bare argument object
   * (no `name`/`arguments` keys) is returned separately as `bodyArgs`.
   */
  function readSpec(node) {
    let spec = null;
    let bodyArgs = null;
    const merge = (candidate) => {
      if (!isPlainObject(candidate)) return;
      if (!spec) spec = {};
      assignAll(spec, candidate);
    };
    for (let i = 0; i < NAME_ATTRS.length; i++) {
      const value = node.attrs[NAME_ATTRS[i]];
      if (typeof value !== 'string' || !LEADING_JSON_RE.test(value.trim())) continue;
      merge(parseArguments(value));
    }
    if (!tagChildren(node).length) {
      const parsed = parseArguments(directText(node));
      if (isPlainObject(parsed)) {
        const isEnvelope = typeof parsed.name === 'string'
          || SPEC_ARGS_ATTRS.some((key) => parsed[key] !== undefined);
        if (isEnvelope) merge(parsed);
        else bodyArgs = parsed;
      }
    }
    return { spec, bodyArgs };
  }

  function pickSpecArgs(spec) {
    for (let i = 0; i < SPEC_ARGS_ATTRS.length; i++) {
      const value = spec[SPEC_ARGS_ATTRS[i]];
      if (value !== undefined) return value;
    }
    return undefined;
  }

  function resolveName(node, spec) {
    if (isPlainObject(spec) && typeof spec.name === 'string' && spec.name.trim()) return spec.name.trim();
    const direct = firstAttr(node, NAME_ATTRS);
    if (direct) {
      if (!LEADING_JSON_RE.test(direct.trim())) return direct.trim();
      const parsed = parseArguments(direct);
      if (isPlainObject(parsed) && typeof parsed.name === 'string' && parsed.name.trim()) return parsed.name.trim();
    }
    const parts = tagChildren(node);
    for (let i = 0; i < parts.length; i++) {
      if (!JSON_KEYWORDS.has(parts[i].keyword)) continue;
      const parsed = parseArguments(collectText(parts[i]));
      if (isPlainObject(parsed) && typeof parsed.name === 'string' && parsed.name.trim()) return parsed.name.trim();
    }
    return direct ? direct.trim() : '';
  }

  function resolveArguments(node, spec, bodyArgs) {
    const args = {};
    if (spec) {
      const provided = pickSpecArgs(spec);
      const parsed = typeof provided === 'string' ? parseArguments(provided) : provided;
      if (isPlainObject(parsed)) assignAll(args, parsed);
    }
    if (isPlainObject(bodyArgs)) assignAll(args, bodyArgs);
    for (let i = 0; i < ARGS_ATTRS.length; i++) {
      const value = node.attrs[ARGS_ATTRS[i]];
      if (typeof value !== 'string' || !LEADING_JSON_RE.test(value.trim())) continue;
      const parsed = parseArguments(value);
      if (isPlainObject(parsed)) assignAll(args, parsed);
      else if (Array.isArray(parsed)) assignValue(args, 'value', parsed);
    }
    const parts = tagChildren(node);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (PARAM_KEYWORDS.has(part.keyword)) {
        assignFromParam(args, part);
      } else if (STRING_KEYWORDS.has(part.keyword)) {
        assignValue(args, firstAttr(part, PARAM_NAME_ATTRS) || 'value', collectText(part).trim());
      } else if (JSON_KEYWORDS.has(part.keyword)) {
        assignFromJsonTag(args, part, firstAttr(part, PARAM_NAME_ATTRS));
      } else if (INVOKE_KEYWORDS.has(part.keyword)) {
        // Nested call: keep whatever arguments it carries.
        const nested = readSpec(part);
        assignAll(args, resolveArguments(part, nested.spec, nested.bodyArgs));
      }
    }
    return args;
  }

  function buildCall(node, src) {
    const parsed = readSpec(node);
    return {
      name: resolveName(node, parsed.spec),
      arguments: resolveArguments(node, parsed.spec, parsed.bodyArgs),
      raw: rawOf(node, src),
    };
  }

  // ----- public API -----

  function isSuppressed(node) {
    return BLOCK_KEYWORDS.has(node.keyword) || INVOKE_KEYWORDS.has(node.keyword);
  }

  function tidy(value) {
    return toText(value)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function collectVisibleText(nodes, out) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.type === 'text') {
        out.push(node.value);
        continue;
      }
      if (isSuppressed(node)) continue;
      out.push(collectText(node));
    }
    return out;
  }

  function hasDsml(text) {
    return DSML_PRESENT_RE.test(toText(text));
  }

  function hasToolCalls(text) {
    return parseToolCalls(text).toolCalls.length > 0;
  }

  /**
   * The visible part of a response: prose only, with every DSML tag and every
   * call body removed. Text without DSML is returned byte-for-byte.
   */
  function sanitizeText(text) {
    return parseToolCalls(text).text;
  }

  /**
   * @param {string} text Raw (possibly partial) DeepSeek response.
   * @returns {{text: string, toolCalls: Array<{name: string, arguments: object, raw: string}>, hasToolCalls: boolean}}
   */
  function parseToolCalls(text) {
    const src = toText(text);
    const root = parseTree(src);
    const toolCalls = [];
    walk(root.children, (node) => {
      if (INVOKE_KEYWORDS.has(node.keyword)) toolCalls.push(buildCall(node, src));
    });
    // Text with no DSML at all is handed back untouched; otherwise the call
    // blocks and control tags are stripped and the prose is tidied up.
    const visibleText = hasDsml(src) ? tidy(collectVisibleText(root.children, []).join('')) : src;
    return { text: visibleText, toolCalls, hasToolCalls: toolCalls.length > 0 };
  }

  return {
    parseToolCalls,
    sanitizeText,
    stripDsml: sanitizeText,
    hasDsml,
    hasToolCalls,
    parseArguments,
  };
});
