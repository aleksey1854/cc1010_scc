// ============================================================
// test/migration.js — всё ли из выгрузки доехало в базу.
//
// Сверяется с самой выгрузкой (dump.json), а не со старым проектом:
// репозиторий должен проверяться сам, без Apps Script рядом.
// ============================================================
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const core = require('../lib/core');

let bad = [];
const chk = (n, c, d) => {
  if (c) console.log('  ✓', n);
  else { console.log('  ✗', n, d !== undefined ? '→ ' + JSON.stringify(d).slice(0, 200) : ''); bad.push(n); }
};
const head = t => console.log('\n━━━ ' + t + ' ━━━');

(async () => {
  require('./reset')();
  const root = path.join(__dirname, '..');
  const dump = JSON.parse(fs.readFileSync(path.join(root, 'dump.json'), 'utf8'));
  const creds = JSON.parse(fs.readFileSync(path.join(root, 'seed-creds.json'), 'utf8'));
  const rows = k => (dump[k] || []).slice(1).filter(r => r && String(r[0] || '').trim());

  head('СОСТАВ');
  const staff = rows('Сотрудники');
  const n = await db.one('SELECT count(*)::int c FROM staff');
  chk('число сотрудников совпало', n.c === staff.length, { выгрузка: staff.length, база: n.c });

  const roles = {};
  staff.forEach(r => { roles[r[2]] = (roles[r[2]] || 0) + 1; });
  const pgRoles = await db.q(`SELECT role::text, count(*)::int c FROM staff GROUP BY role`);
  chk('роли распределены одинаково',
    pgRoles.every(r => r.c === roles[r.role]) && pgRoles.length === Object.keys(roles).length,
    { выгрузка: roles, база: Object.fromEntries(pgRoles.map(r => [r.role, r.c])) });

  chk('у всех есть логин', (await db.one(`SELECT count(*)::int c FROM staff WHERE login IS NULL`)).c === 0);
  chk('у всех есть хеш', (await db.one(`SELECT count(*)::int c FROM staff WHERE password_hash IS NULL`)).c === 0);
  chk('открытых паролей не осталось',
    (await db.one(`SELECT count(*)::int c FROM staff WHERE password_hash NOT LIKE 'sha256$%'`)).c === 0);
  chk('даты найма перенесены',
    (await db.one(`SELECT count(*)::int c FROM staff WHERE hired_at IS NOT NULL`)).c === staff.length);

  head('ВХОД ПОСЛЕ ПЕРЕНОСА');
  let ok = 0, fails = [];
  for (const [full, team, role, login, pass] of creds) {
    const s = await db.staffByLogin(login);
    if (s && core.verifyPassword(pass, s.password_hash)) ok++;
    else fails.push(full);
  }
  chk('все ' + creds.length + ' входят своими паролями', ok === creds.length, { вошло: ok, примеры: fails.slice(0, 3) });
  const s0 = await db.staffByLogin(creds[0][3]);
  chk('чужой пароль не подходит', !core.verifyPassword(creds[1][4], s0.password_hash));
  chk('логин нечувствителен к регистру', !!(await db.staffByLogin(creds[0][3].toUpperCase())));

  head('ЧЕК-ЛИСТ');
  const crit = rows('Критерии ЧЛ');
  const cfg = await db.getChecklist(true);
  const items = cfg.blocks.reduce((s, b) => s + b.items.length, 0);
  chk('пункты перенесены', items === crit.length, { выгрузка: crit.length, база: items });
  chk('блоков 9', cfg.blocks.length === 9, cfg.blocks.length);
  chk('максимум 90 баллов', cfg.maxTotal === 90, cfg.maxTotal);
  chk('«Сомнительно» = половина «Положительно»',
    cfg.blocks.every(b => b.items.every(i => {
      const p = (i.options.find(o => o.value === 'pos') || {}).points;
      const d = (i.options.find(o => o.value === 'dbt') || {}).points;
      return p === undefined || d === undefined || Math.abs(d - p / 2) < 1e-9;
    })));

  head('СПРАВОЧНИКИ');
  chk('тематики', cfg.topics.length === rows('Тематики').length, { база: cfg.topics.length });
  chk('города', cfg.cities.length === rows('Города').length, { база: cfg.cities.length });
  chk('процент выборки', cfg.samplePercent === 2, cfg.samplePercent);

  head('РАСЧЁТ НА ПЕРЕНЕСЁННОМ ЧЕК-ЛИСТЕ');
  const all = {};
  cfg.blocks.forEach(b => b.items.forEach(i => { if (i.kind === 'score') all[i.code] = 'pos'; }));
  chk('всё положительно = 100,00', core.computeScore(cfg, all).score === 100);
  chk('одна «сомнительно» = 98,33',
    core.computeScore(cfg, Object.assign({}, all, { B2P1: 'dbt' })).score === 98.33,
    core.computeScore(cfg, Object.assign({}, all, { B2P1: 'dbt' })).score);
  chk('жалоба = 0,00', core.computeScore(cfg, Object.assign({}, all, { B8P2: 'yes' })).score === 0);
  chk('благодарность = 100,00', core.computeScore(cfg, Object.assign({}, all, { B8P1: 'yes' })).score === 100);
  chk('жалоба сильнее благодарности',
    core.computeScore(cfg, Object.assign({}, all, { B8P1: 'yes', B8P2: 'yes' })).score === 0);
  chk('пустой чек-лист = 0,00', core.computeScore(cfg, {}).score === 0);

  head('ПОВТОРНЫЙ ПЕРЕНОС НЕ ДУБЛИРУЕТ');
  const { execSync } = require('child_process');
  execSync(`node ${path.join(root, 'scripts', 'migrate.js')} ${path.join(root, 'dump.json')}`, { stdio: 'pipe' });
  const again = await db.one('SELECT count(*)::int c FROM staff');
  chk('состав не задвоился', again.c === staff.length, { было: staff.length, стало: again.c });

  console.log(`\nПРОВАЛЕНО: ${bad.length}`);
  bad.forEach(b => console.log('   ·', b));
  await db.pool.end();
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('СБОЙ:', e); process.exit(1); });
