// ============================================================
// scripts/embed-template.js — зашить макет чек-листа в код.
//
// На Vercel в бандл едут только те файлы, которые видно через require.
// Макет лежит .xlsx-файлом, и функция его не находила: «File not found».
// Поэтому держим рядом сгенерированный модуль с тем же файлом в base64.
//
// Правите assets/checklist-template.xlsx — перегенерируйте модуль:
//   node scripts/embed-template.js
// Расхождение ловит тест (test/parity.js).
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'assets', 'checklist-template.xlsx');
const OUT = path.join(__dirname, '..', 'lib', 'checklist-template.js');

const buf = fs.readFileSync(SRC);
const sha = crypto.createHash('sha256').update(buf).digest('hex');

fs.writeFileSync(OUT,
  '// СГЕНЕРИРОВАНО scripts/embed-template.js — руками не править.\n' +
  '// Источник: assets/checklist-template.xlsx\n' +
  'module.exports = {\n' +
  "  sha256: '" + sha + "',\n" +
  "  base64: '" + buf.toString('base64') + "'\n" +
  '};\n');

console.log('макет зашит: ' + Math.round(buf.length / 1024) + ' КБ, sha ' + sha.slice(0, 12));
