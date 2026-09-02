// ============================================================
// scripts/load-real.js — наполнение боевой выгрузкой из Таблиц.
//
// На вход — JSON, собранный из «ВНУТРЕННЯЯ Рандомная выгрузка звонков»:
//   { people: {ключ: {name, group}}, requests: [...], accepted: [...] }
//
// Что делает:
//   · заводит операторов из выгрузки и контролирующий состав;
//   · создаёт заявки операторов за месяц;
//   · там, где в выгрузке стоит балл, собирает чек-лист, который даёт
//     ровно этот балл, и привязывает оценку к заявке;
//   · заливает статистику принятых звонков по дням.
//
// Схема и справочники должны быть накатаны заранее:
//   node scripts/db-reset.js && node scripts/apply-reference.js
//
//   DATABASE_URL=... node scripts/load-real.js august.json
// ============================================================
const fs = require('fs');
const core = require('../lib/core');
const db = require('../lib/db');

const SRC = process.argv[2];
if (!SRC) { console.error('укажите файл выгрузки'); process.exit(1); }

// Контролирующий состав в выгрузке не значится — заводим его отдельно.
// Кто именно оценивал, в исходных данных не сохранилось.
const STAFF_EXTRA = [
  ['Онуприенко Даниил', 'СКК', 'sqc'],
  ['Ковалёва Анастасия', 'СКК', 'qc'],
  ['Смирнова Полина', 'СКК', 'qc'],
  ['Тарасова Ольга', 'СКК', 'qc'],
  ['Белова Ирина', 'СКК', 'qc'],
  ['Морозов Артём', 'Инвитро', 'srgo'],
  ['Никитина Елена', 'Инвитро', 'manager'],
  ['Волкова Дарья', 'АУП', 'admin']
];

const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// свой генератор: одна и та же выгрузка даёт один и тот же результат
let seed = 20260901;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = a => a[Math.floor(rnd() * a.length)];
const pass = () => Array.from({ length: 10 }, () => ALPHABET[Math.floor(rnd() * ALPHABET.length)]).join('');

// ---------- подбор ответов под известный балл ----------
// В выгрузке сохранился только итог. Разбираем его обратно на ошибки:
// снимаем с пунктов ровно столько баллов, сколько не хватает до 90.
function answersForScore(items, score) {
  const answers = {};
  if (score === null || score === undefined) return answers;
  if (score <= 0) {                       // ноль бывает только от жалобы или недопустимого
    return { __zero: true };
  }
  const target = Math.round((90 - score * 0.9) * 2) / 2;   // сколько баллов потерять
  if (target <= 0) return answers;

  // варианты потерь: «сомнительно» — половина веса, «отрицательно» — весь
  const losses = [];
  items.forEach(it => {
    if (it.kind !== 'score') return;
    const pos = Number(it.pos);
    if (it.dbt !== null && it.dbt !== undefined) losses.push({ code: it.code, val: 'dbt', lose: pos - Number(it.dbt) });
    losses.push({ code: it.code, val: 'neg', lose: pos });
  });
  losses.sort((a, b) => b.lose - a.lose);

  let left = target;
  const used = new Set();
  for (const l of losses) {
    if (left <= 0) break;
    if (used.has(l.code)) continue;
    if (l.lose <= left + 1e-9) {
      answers[l.code] = l.val;
      used.add(l.code);
      left = Math.round((left - l.lose) * 2) / 2;
    }
  }
  if (left > 0) answers.__inexact = left;     // подобрать точно не вышло
  return answers;
}

async function main() {
  const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const people = src.people, reqs = src.requests, accepted = src.accepted;

  const cfg = await db.getChecklist(true);
  const items = [];
  cfg.blocks.forEach(b => b.items.forEach(it => {
    const pos = (it.options.find(o => o.value === 'pos') || {}).points;
    const dbt = (it.options.find(o => o.value === 'dbt') || {}).points;
    items.push({ code: it.code, kind: it.kind, rule: it.rule, pos, dbt: dbt === undefined ? null : dbt });
  }));
  const flagZero = items.filter(i => i.kind === 'flag' && i.rule === 'force0').map(i => i.code);

  const topics = cfg.topics.filter(t => t.subtopic);
  const cities = cfg.cities;
  const criteria = ['Длит: короткий (до 3 мин)', 'Длит: средний (3-5 мин)',
                    'Длит: длинный (5-10 мин)', 'Длит: затянутый (более 10 мин)'];

  const stat = { операторов: 0, контролёров: 0, заявок: 0, оценок: 0, статистики: 0, неточных: 0 };
  const creds = [];
  const taken = {};
  const idByKey = new Map();

  await db.tx(async (t) => {
    // ---------- состав ----------
    const add = async (fullName, team, role) => {
      const login = core.suggestLogin(fullName, taken);
      taken[login] = true;
      const pw = pass();
      const r = await t.one(
        `INSERT INTO staff (full_name, team, role, login, password_hash, hired_at)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
        [fullName, team, role, login, core.hashPassword(pw),
         core.isoDate(new Date(2024 + Math.floor(rnd() * 2), Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28)))]);
      if (r) creds.push([fullName, team, role, login, pw]);
      return r ? r.id : null;
    };

    for (const [key, p] of Object.entries(people)) {
      const id = await add(p.name, p.group, 'operator');
      if (id) { idByKey.set(key, id); stat.операторов++; }
    }
    const qcIds = [];
    for (const [name, team, role] of STAFF_EXTRA) {
      const id = await add(name, team, role);
      if (id) { stat.контролёров++; if (role === 'qc' || role === 'sqc') qcIds.push({ id, name }); }
    }
    // РГО на каждую группу операторов
    const groups = [...new Set(Object.values(people).map(p => p.group))].sort();
    for (const g of groups) {
      const id = await add('РГО ' + g, g, 'rgo');
      if (id) stat.контролёров++;
    }

    // ---------- заявки и оценки ----------
    let n = 0;
    for (const r of reqs) {
      const opId = idByKey.get(r.key);
      if (!opId) continue;
      const team = people[r.key].group;
      const publicId = 'REQ-A' + String(++n).padStart(4, '0');
      const scored = r.score !== null && r.score !== undefined;

      const row = await t.one(
        `INSERT INTO call_requests
           (public_id, operator_id, team, call_date, call_time, phone, call_type,
            status, operator_note, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING RETURNING id`,
        [publicId, opId, team, r.date, r.time, r.phone, 'СР',
         scored ? 'checked' : 'new', r.comment, r.ts]);
      if (!row) continue;
      stat.заявок++;

      await t.q(`INSERT INTO request_events (request_id, actor_id, actor_name, event, details, at)
                 VALUES ($1,$2,$3,'created',$4,$5)`,
        [row.id, opId, people[r.key].name, 'Звонок ' + core.fmtDate(r.date) + ' ' + r.time, r.ts]);

      if (!scored) continue;

      const qc = qcIds[n % qcIds.length];
      const picked = answersForScore(items, r.score);

      // Считаем по полному листу: неотвеченный пункт — это ноль баллов,
      // поэтому сперва проставляем значения по умолчанию, а поверх — ошибки.
      const full = {};
      cfg.blocks.forEach(b => b.items.forEach(it => { full[it.code] = it.def || (it.kind === 'flag' ? 'no' : 'pos'); }));
      const deviations = {};
      if (picked.__zero) {
        full[flagZero[0]] = 'yes';                        // недопустимое событие
        deviations[flagZero[0]] = 'yes';
      } else {
        if (picked.__inexact) stat.неточных++;
        Object.keys(picked).forEach(k => {
          if (k.startsWith('__')) return;
          full[k] = picked[k];
          deviations[k] = picked[k];
        });
      }

      const res = core.computeScore(cfg, full);
      const topic = pick(topics);
      const city = pick(cities);
      const evId = 'EV-A' + String(n).padStart(4, '0');

      const ev = await t.one(
        `INSERT INTO evaluations
           (public_id, operator_id, qc_id, request_id, team, call_date, call_time, phone, iso_week,
            criterion, topic, subtopic, city, agglomeration, review_source,
            score, pts_got, pts_max, critical, minor, violation, complaint, gratitude, complaint_mark, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
         ON CONFLICT DO NOTHING RETURNING id`,
        [evId, opId, qc.id, row.id, team, r.date, r.time, r.phone, core.isoWeek(r.date),
         pick(criteria), topic.topic, topic.subtopic, city.city, city.agglomeration, '',
         res.score, res.got, res.max, res.critical, res.minor,
         res.violation, res.complaint, res.gratitude, res.complaintMark, r.ts]);
      if (!ev) continue;
      stat.оценок++;

      const vals = [], params = [];
      let i = 1;
      let first = true;
      for (const [code, val] of Object.entries(deviations)) {
        vals.push(`($${i++},$${i++},$${i++},$${i++})`);
        // комментарий оператора из формы кладём к первой ошибке — он про неё и был
        params.push(ev.id, code, val, first && r.comment ? r.comment.slice(0, 400) : '');
        first = false;
      }
      if (vals.length) {
        await t.q(`INSERT INTO evaluation_answers (evaluation_id, item_code, value, comment)
                   VALUES ${vals.join(',')}`, params);
      }

      await t.q(`UPDATE call_requests SET checked_by=$2, checked_at=$3, rating=$4 WHERE id=$1`,
        [row.id, qc.name, r.ts, res.score]);
      await t.q(`INSERT INTO request_events (request_id, actor_id, actor_name, event, details, at)
                 VALUES ($1,$2,$3,'evaluated',$4,$5)`,
        [row.id, qc.id, qc.name, 'Оценка ' + evId + ' · ' + core.pct2(res.score), r.ts]);
    }

    // ---------- принятые звонки ----------
    for (const a of accepted) {
      const opId = idByKey.get(a.key);
      if (!opId) continue;
      await t.q(`INSERT INTO accepted_calls (stat_date, operator_id, accepted) VALUES ($1,$2,$3)
                 ON CONFLICT (stat_date, operator_id) DO UPDATE SET accepted = EXCLUDED.accepted`,
        [a.date, opId, a.accepted]);
      stat.статистики++;
    }
  });

  fs.writeFileSync('real-creds.json', JSON.stringify(creds, null, 1));

  console.log('=== ЗАГРУЖЕНО ===');
  for (const [k, v] of Object.entries(stat)) console.log('  ' + k.padEnd(14) + v);
  const chk = await db.one(`SELECT round(avg(score),2)::float avg, min(score)::float lo, max(score)::float hi
                              FROM evaluations`);
  console.log('  средний балл  ' + chk.avg + ' (от ' + chk.lo + ' до ' + chk.hi + ')');
  console.log('  учётки в real-creds.json');
  await db.pool.end();
}

main().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
