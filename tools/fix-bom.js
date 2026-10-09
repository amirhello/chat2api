// اضافه کردن BOM به فایل PowerShell برای اینکه فارسی درست دیده بشه
const fs = require('fs');
const p = require('path').join(__dirname, '..', 'tools', 'test-chat.ps1');
let c = fs.readFileSync(p);
if (c[0] === 0xef && c[1] === 0xbb && c[2] === 0xbf) {
  console.log('BOM already present');
} else {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  fs.writeFileSync(p, Buffer.concat([bom, c]));
  console.log('BOM added');
}
