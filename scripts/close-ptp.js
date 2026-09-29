// ============================================================
// scripts/close-ptp.js — закрытие группы ИНВ-ПТП с 01.10.2026.
//
// Список от Даниила: десять операторов переходят в другие группы,
// пятеро операторов и РГО Казбекова увольняются с 1 октября.
//
// Переводим именно утром 01.10, а не заранее: группа оценки (evaluations.team)
// записывается на момент прослушки, и перевод накануне унёс бы сентябрьские
// оценки ПТП в чужие группы. Уволенные ещё работают 30.09 — логин им нужен
// до конца дня.
//
// Логины и пароли переведённых не меняются. Уволенным — как кнопкой
// «Уволить»: вход закрыт, в списках они ещё три месяца (на случай жалобы).
//
//   node --env-file=.env scripts/close-ptp.js            — только показать план
//   node --env-file=.env scripts/close-ptp.js --apply    — выполнить (с 01.10 МСК)
// ============================================================
const db = require('../lib/db');

const FROM = 'ИНВ-ПТП';
const DAY = '2026-10-01';

const MOVES = [
  ['Браславская Инна', 'ИНВ-УД1'],
  ['Вяткина Лариса', 'ИНВ-1'],
  ['Калач Виктория', 'ИНВ-УД1'],
  ['Маньшина Лийя', 'ИНВ-РДН'],
  ['Орешина Вероника', 'ИНВ-УД3'],
  ['Пинчук Вероника', 'ИНВ-УД1'],
  ['Рываева Татьяна', 'ИНВ-2'],
  ['Тарасова Оксана', 'ИНВ-УД1'],
  ['Туковская Лариса', 'ИНВ-УД3'],
  ['Чучкалова Наталья', 'ИНВ-ДЦ']
];
const FIRED = [
  'Круглова Олеся', 'Суханова Алина', 'Фирсова Александра',
  'Чембулаева Любовь', 'Ясопова Виктория', 'Казбекова Алия'
];

// сегодняшняя дата по Москве — от неё зависит, можно ли уже переводить
const mskToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);

(async () => {
  const apply = process.argv.includes('--apply');
  const problems = [];

  const staff = await db.q(`SELECT id, full_name, team, role, active, login FROM staff
                             WHERE active AND full_name = ANY($1)`,
    [MOVES.map(m => m[0]).concat(FIRED)]);
  const byName = new Map(staff.map(s => [s.full_name, s]));
  const groups = new Set((await db.q(`SELECT DISTINCT team FROM staff WHERE active`)).map(r => r.team));

  console.log('Переводы:');
  for (const [name, to] of MOVES) {
    const s = byName.get(name);
    if (!s) problems.push(name + ' — не найден среди работающих');
    else if (s.team !== FROM) problems.push(name + ' — уже в ' + s.team + ', не в ' + FROM);
    if (!groups.has(to)) problems.push(to + ' — такой группы нет');
    console.log('  ' + name.padEnd(22) + (s ? s.team : '?') + ' → ' + to + (s && s.login ? '   логин ' + s.login + ' не меняется' : ''));
  }
  console.log('Увольнения с ' + DAY.split('-').reverse().join('.') + ':');
  for (const name of FIRED) {
    const s = byName.get(name);
    if (!s) problems.push(name + ' — не найдена среди работающих');
    else if (s.team !== FROM) problems.push(name + ' — в группе ' + s.team + ', не в ' + FROM);
    console.log('  ' + name.padEnd(22) + (s ? s.team + ' · ' + s.role : '?'));
  }

  // кто ещё останется в ПТП после закрытия — не должно быть никого
  const rest = (await db.q(`SELECT full_name, role FROM staff WHERE active AND team = $1`, [FROM]))
    .filter(s => !MOVES.some(m => m[0] === s.full_name) && FIRED.indexOf(s.full_name) < 0);
  rest.forEach(s => problems.push(s.full_name + ' (' + s.role + ') — нет в списке, останется в ' + FROM));

  if (problems.length) {
    console.log('\nНЕ ВЫПОЛНЯЮ — расхождения:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  if (!apply) {
    console.log('\nПлан сходится. Выполнить: --apply (не раньше ' + DAY + ' по Москве)');
    process.exit(0);
  }
  if (mskToday() < DAY && process.env.TEST_DB !== '1') {     // на тестовой базе — для проверки
    console.log('\nРано: по Москве ещё ' + mskToday() + '. Переводим утром ' + DAY + '.');
    process.exit(1);
  }

  await db.tx(async (t) => {
    for (const [name, to] of MOVES) {
      await t.q(`UPDATE staff SET team = $2, updated_at = now() WHERE active AND full_name = $1`, [name, to]);
      await t.q(`INSERT INTO audit_log (event, who, details) VALUES ($1, $2, $3)`,
        ['Перевод в группу', 'закрытие ' + FROM, name + ': ' + FROM + ' → ' + to]);
    }
    for (const name of FIRED) {
      const r = await t.one(`UPDATE staff SET active = false, login = NULL, dismissed_at = $2, updated_at = now()
                              WHERE active AND full_name = $1 RETURNING id`, [name, DAY]);
      await t.q(`DELETE FROM sessions WHERE staff_id = $1`, [r.id]);
      await t.q(`INSERT INTO audit_log (event, who, details) VALUES ($1, $2, $3)`,
        ['Уволен сотрудник', 'закрытие ' + FROM, name]);
    }
  });
  db.dropChecklistCache && db.dropChecklistCache();
  const left = await db.one(`SELECT count(*)::int n FROM staff WHERE active AND team = $1`, [FROM]);
  console.log('\nГотово: переведено ' + MOVES.length + ', уволено ' + FIRED.length + '. В ' + FROM + ' осталось: ' + left.n);
  process.exit(0);
})().catch(e => { console.error('СБОЙ:', e.message); process.exit(1); });
