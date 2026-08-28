// Данные после переноса обязаны совпадать со старой системой до цифры
const db = require('../lib/db');
const core = require('../lib/core');
const { harness, fixture, requireEnv } = require('./legacy');
let bad = [];
const chk = (n, c, d) => { if (c) console.log('  ✓', n); else { console.log('  ✗', n, d !== undefined ? '→ ' + JSON.stringify(d) : ''); bad.push(n); } };

(async () => {
  requireEnv('DATABASE_URL');
  const { buildCtx } = harness();
  const dump = fixture('DUMP_JSON', 'dump.json');
  const old = buildCtx(dump);
  const creds = fixture('GENERATED_JSON', 'generated.json').creds;

  console.log('━━━ СОСТАВ ━━━');
  const n = await db.one('SELECT count(*)::int c FROM staff');
  old._MEM = {};
  chk('196 сотрудников', n.c === old.staffAll_().length && n.c === 196, { pg: n.c, sheets: old.staffAll_().length });
  const byRole = await db.q(`SELECT role::text, count(*)::int c FROM staff GROUP BY role ORDER BY role`);
  const oldRoles = {};
  old.staffAll_().forEach(r => oldRoles[r[2]] = (oldRoles[r[2]] || 0) + 1);
  chk('роли распределены одинаково',
    byRole.every(r => r.c === oldRoles[r.role]), { pg: byRole, sheets: oldRoles });
  const noHash = await db.one(`SELECT count(*)::int c FROM staff WHERE password_hash IS NULL`);
  chk('у всех есть хеш пароля', noHash.c === 0, noHash.c);
  const noLogin = await db.one(`SELECT count(*)::int c FROM staff WHERE login IS NULL`);
  chk('у всех есть логин', noLogin.c === 0, noLogin.c);

  console.log('\n━━━ ВХОД ПОСЛЕ ПЕРЕЕЗДА ━━━');
  let ok = 0, fails = [];
  for (const [name, team, roleRu, login, pass] of creds) {
    const s = await db.staffByLogin(login);
    if (s && core.verifyPassword(pass, s.password_hash)) ok++;
    else fails.push(name);
  }
  chk('все 196 входят прежними паролями', ok === 196, { вошло: ok, примеры: fails.slice(0, 3) });
  const s0 = await db.staffByLogin(creds[0][3]);
  chk('чужой пароль не подходит', !core.verifyPassword(creds[1][4], s0.password_hash));

  console.log('\n━━━ ЧЕК-ЛИСТ ━━━');
  const cfg = await db.getChecklist(true);
  old._MEM = {};
  const oldCfg = old.getChecklistConfig_();
  chk('9 блоков', cfg.blocks.length === oldCfg.blocks.length, { pg: cfg.blocks.length, sheets: oldCfg.blocks.length });
  chk('27 пунктов', cfg.blocks.reduce((s, b) => s + b.items.length, 0) === 27);
  chk('максимум 90 баллов', cfg.maxTotal === oldCfg.maxTotal && cfg.maxTotal === 90, { pg: cfg.maxTotal, sheets: oldCfg.maxTotal });
  const bmax = cfg.blocks.map(b => b.max).join('/');
  const obmax = oldCfg.blocks.map(b => b.max).join('/');
  chk('максимумы блоков совпали', bmax === obmax, { pg: bmax, sheets: obmax });
  chk('процент выборки перенесён', cfg.samplePercent === 2, cfg.samplePercent);
  chk('тематик 18, городов 20', cfg.topics.length === 18 && cfg.cities.length === 20, { t: cfg.topics.length, c: cfg.cities.length });

  console.log('\n━━━ ЖУРНАЛ ОЦЕНОК ━━━');
  old._MEM = {};
  const oldJ = old.journalLight_();
  const cnt = await db.one('SELECT count(*)::int c FROM evaluations');
  chk('число оценок совпало', cnt.c === oldJ.length, { pg: cnt.c, sheets: oldJ.length });

  const pgRows = await db.q(`
    SELECT e.public_id, s.full_name AS op, e.team, e.call_date, e.score, e.critical, e.minor,
           e.violation, e.complaint, e.gratitude, e.iso_week
      FROM evaluations e JOIN staff s ON s.id = e.operator_id ORDER BY e.public_id`);
  const oldById = new Map(oldJ.map(e => [e.id, e]));
  let mism = [];
  for (const r of pgRows) {
    const o = oldById.get(r.public_id);
    if (!o) { mism.push({ id: r.public_id, why: 'нет в старом' }); continue; }
    const pairs = [
      ['оператор', r.op, o.operator], ['группа', r.team, o.group],
      ['дата', core.isoDate(r.call_date), o.callDate], ['балл', Number(r.score), o.score],
      ['критичных', r.critical, o.critical], ['некритичных', r.minor, o.minor],
      ['недопустимое', r.violation, o.violation], ['жалоба', r.complaint, o.complaint],
      ['благодарность', r.gratitude, o.gratitude], ['неделя', r.iso_week, o.week]
    ];
    for (const [f, a, b] of pairs) if (a !== b && mism.length < 4) mism.push({ id: r.public_id, поле: f, pg: a, sheets: b });
  }
  chk('все поля всех оценок совпали', mism.length === 0, mism);

  const sums = await db.one('SELECT round(avg(score),2)::float a, count(*)::int c FROM evaluations');
  const refAvg = core.round2(oldJ.reduce((s, e) => s + e.score, 0) / oldJ.length);
  chk('средний балл по журналу совпал', sums.a === refAvg, { pg: sums.a, sheets: refAvg });

  console.log('\n━━━ ОТВЕТЫ ПО ПУНКТАМ ━━━');
  const ans = await db.one('SELECT count(*)::int c FROM evaluation_answers');
  console.log('     строк ответов:', ans.c, '(вместо', oldJ.length * 54, 'колонок в листе)');
  const errs = await db.one(`SELECT count(*)::int c FROM evaluation_answers WHERE value IN ('neg','dbt')`);
  old._MEM = {};
  const oldErrs = old.readJournal_().reduce((s, e) => s + e.failed.length, 0);
  chk('число ошибок совпало', errs.c === oldErrs, { pg: errs.c, sheets: oldErrs });
  const withCmt = await db.one(`SELECT count(*)::int c FROM evaluation_answers WHERE comment <> ''`);
  chk('комментарии перенесены', withCmt.c > 0, withCmt.c);

  console.log('\n━━━ ОБЪЁМ ━━━');
  const size = await db.one(`
    SELECT pg_size_pretty(pg_total_relation_size('evaluations') + pg_total_relation_size('evaluation_answers')) s,
           (pg_total_relation_size('evaluations') + pg_total_relation_size('evaluation_answers'))::float / GREATEST((SELECT count(*) FROM evaluations),1) b`);
  console.log('     оценки + ответы:', size.s, '| на одну оценку:', Math.round(size.b), 'байт');
  console.log('     в Google Таблицах было: 928 байт на оценку');

  console.log(`\nПРОВАЛЕНО: ${bad.length}`);
  bad.forEach(b => console.log('   ·', b));
  await db.pool.end();
  process.exit(bad.length ? 1 : 0);
})();
