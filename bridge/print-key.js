'use strict';

/**
 * چاپ API Key ذخیره‌شده — برای راحتی در شل
 *   node bridge/print-key.js
 */

const { loadOrCreateApiKey, resolveKeyFile } = require('./config');

process.stdout.write(loadOrCreateApiKey());
console.log(`\n(ذخیره شده در ${resolveKeyFile()})`);
