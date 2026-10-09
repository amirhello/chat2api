'use strict';

/** Static checks for the DeepSeek-only MV3 extension. */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'extension');
let pass = 0;
let fail = 0;

function ok(message) { pass += 1; console.log(`  ✅ ${message}`); }
function bad(message, detail) { fail += 1; console.log(`  ❌ ${message} — ${detail}`); }
function exists(relative) { return fs.existsSync(path.join(ROOT, relative)); }

console.log('اعتبارسنجی اکستنشن DeepSeek:');

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  ok('manifest.json قابل parse');
} catch (err) {
  bad('manifest.json', err.message);
  process.exit(1);
}

for (const field of ['manifest_version', 'name', 'version']) {
  if (manifest[field] === undefined) bad(`manifest.${field}`, 'missing');
  else ok(`manifest.${field} = ${JSON.stringify(manifest[field])}`);
}
if (manifest.manifest_version !== 3) bad('manifest_version', 'باید 3 باشد');

const background = manifest.background?.service_worker;
if (!background) bad('background.service_worker', 'missing');
else if (!exists(background)) bad('background.service_worker', `${background} پیدا نشد`);
else ok(`background.service_worker → ${background}`);

const scripts = manifest.content_scripts || [];
if (scripts.length === 0) bad('content_scripts', 'خالی است');
for (const [index, script] of scripts.entries()) {
  if (!Array.isArray(script.matches) || !script.matches.includes('https://chat.deepseek.com/*')) {
    bad(`content_scripts[${index}].matches`, 'DeepSeek match وجود ندارد');
  } else ok('content_scripts → https://chat.deepseek.com/*');
  for (const scriptFile of script.js || []) {
    if (!exists(scriptFile)) bad(`content_scripts[${index}].js`, `${scriptFile} پیدا نشد`);
    else ok(`content script → ${scriptFile}`);
  }
}

const popup = manifest.action?.default_popup;
if (!popup) bad('action.default_popup', 'missing');
else if (!exists(popup)) bad('action.default_popup', `${popup} پیدا نشد`);
else ok(`popup → ${popup}`);

for (const [size, file] of Object.entries(manifest.icons || {})) {
  if (!exists(file)) bad(`icons.${size}`, `${file} پیدا نشد`);
  else ok(`icons.${size} → ${file}`);
}

const expectedPermissions = new Set(['tabs', 'alarms']);
const permissions = manifest.permissions || [];
const unexpected = permissions.filter((permission) => !expectedPermissions.has(permission));
if (unexpected.length) bad('permissions', `غیرضروری: ${unexpected.join(', ')}`);
else ok(`permissions = [${permissions.join(', ')}]`);

const hosts = manifest.host_permissions || [];
if (!hosts.some((host) => host.includes('chat.deepseek.com'))) bad('host_permissions', 'DeepSeek host وجود ندارد');
else ok('host_permissions شامل DeepSeek است');
if (!hosts.some((host) => host.includes('127.0.0.1:20258'))) bad('host_permissions', 'پورت bridge جدید مجاز نیست');
else ok('host_permissions شامل bridge روی 20258 است');

if (manifest.web_accessible_resources?.length) {
  bad('web_accessible_resources', 'این نسخه به hook یا resource عمومی نیاز ندارد');
} else ok('web_accessible_resources خالی است');

function collectJs(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...collectJs(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) result.push(full);
  }
  return result;
}

const jsFiles = new Set([path.join(ROOT, background || ''), ...collectJs(ROOT)].filter(Boolean));
for (const full of jsFiles) {
  const relative = path.relative(ROOT, full);
  try {
    new Function(fs.readFileSync(full, 'utf8'));
    ok(`syntax ${relative}`);
  } catch (err) {
    bad(`syntax ${relative}`, err.message);
  }
}

console.log(`\n${pass} مورد OK، ${fail} مورد مشکل`);
process.exit(fail > 0 ? 1 : 0);
