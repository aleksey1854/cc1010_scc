// ============================================================
// test/legacy.js — общее для обеих сверок.
//
// Обе проверки сравнивают новый код со старым проектом на Apps Script,
// а он лежит вне этого репозитория, как и выгрузки листов с персональными
// данными. Пути задаются переменными окружения (см. .env.example).
// Если их нет — сверка не падает, а честно сообщает, что пропущена.
// ============================================================
const fs = require('fs');
const path = require('path');

const abs = p => (path.isAbsolute(p) ? p : path.resolve(process.cwd(), p));

function skip(why) {
  console.log('⚠  сверка пропущена: ' + why);
  console.log('   старый проект и выгрузки листов в репозиторий не входят, пути — в .env.example');
  process.exit(0);
}

// харнесс старого проекта: buildCtx() поднимает контекст Apps Script
function harness() {
  const p = process.env.LEGACY_HARNESS;
  if (!p) skip('не задан LEGACY_HARNESS — путь к харнессу старого проекта');
  try {
    return require(abs(p));
  } catch (e) {
    skip('не подгружается харнесс ' + p + ' (' + e.message + ')');
  }
}

// выгрузка листа: JSON вида { «Сотрудники»: [[...]], ... }
function fixture(envName, dflt) {
  const p = abs(process.env[envName] || dflt);
  if (!fs.existsSync(p)) skip('нет файла ' + p + ' — задайте ' + envName);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function requireEnv(name) {
  if (!process.env[name]) skip('не задан ' + name);
}

module.exports = { harness, fixture, requireEnv, skip };
