// ============================================================
// scripts/migrate.js — перенос из выгрузки Google Таблиц в Postgres.
//
// На вход — JSON вида { «Сотрудники»: [[...]], «Журнал оценок»: [[...]], ... },
// то есть ровно то, что отдаёт лист при экспорте.
// Хеши паролей переносятся как есть: формат sha256$1200$соль$хеш
// одинаков в Apps Script и в Node, никто не теряет доступ.
//
// Запуск:  DATABASE_URL=... node scripts/migrate.js dump.json
// ============================================================
const fs = require('fs');
const core = require('../lib/core');
const db = require('../lib/db');

const RU_ROLE = new Set(core.ALLOWED_ROLES);

function cell(row, i) { return row && row[i] !== undefined && row[i] !== null ? String(row[i]).trim() : ''; }

async function main() {
  const path = process.argv[2];
  if (!path) { console.error('укажите файл выгрузки'); process.exit(1); }
  const dump = JSON.parse(fs.readFileSync(path, 'utf8'));
  const stat = {};

  await db.tx(async (t) => {
    // ---------- 1. Сотрудники ----------
    // Колонки: ФИО | Группа | Роль | Пароль | Дата начала | Логин | Хеш
    const staff = dump['Сотрудники'] || [];
    const taken = {};
    let plain = 0;
    for (let i = 1; i < staff.length; i++) {
      const r = staff[i];
      const name = cell(r, 0);
      if (!name) continue;
      const role = RU_ROLE.has(cell(r, 2)) ? cell(r, 2) : 'operator';
      let login = core.normLogin(cell(r, 5));
      if (!login) login = core.suggestLogin(name, taken);
      taken[login] = true;

      let hash = cell(r, 6) || null;
      const open = cell(r, 3);
      // если в колонке D остался открытый пароль — хешируем на лету
      if (!hash && open) { hash = core.hashPassword(open); plain++; }

      const hired = core.toDateObj(cell(r, 4));
      await t.q(`INSERT INTO staff (full_name, team, role, login, password_hash, hired_at)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 ON CONFLICT DO NOTHING`,
        [name, cell(r, 1), role, login, hash, hired ? core.isoDate(hired) : null]);
    }
    stat.staff = (await t.one('SELECT count(*)::int n FROM staff')).n;
    stat.hashedOnTheFly = plain;

    // ---------- 2. Чек-лист ----------
    // Колонки: ID | Блок | Пункт | Тип | Полож. | Сомнит. | Отриц. | Не треб. | Правило | Активен
    const crit = dump['Критерии ЧЛ'] || [];
    const blockOrder = new Map();
    for (let i = 1; i < crit.length; i++) {
      const r = crit[i];
      const id = cell(r, 0);
      if (!id) continue;
      const bname = cell(r, 1);
      const bcode = (id.match(/^B\d+/) || ['B0'])[0];
      if (!blockOrder.has(bcode)) {
        blockOrder.set(bcode, blockOrder.size + 1);
        await t.q(`INSERT INTO checklist_blocks (code, name, sort_order) VALUES ($1,$2,$3)
                   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name`,
          [bcode, bname, blockOrder.get(bcode)]);
      }
      const num = v => { const s = cell(r, v); return s === '' ? null : Number(s.replace(',', '.')); };
      await t.q(`INSERT INTO checklist_items
                   (block_id, code, text, kind, rule, pts_pos, pts_dbt, pts_neg, pts_na, active, sort_order, default_value)
                 VALUES ((SELECT id FROM checklist_blocks WHERE code=$1),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                 ON CONFLICT (code) DO NOTHING`,
        [bcode, id, cell(r, 2), cell(r, 3) || 'score', cell(r, 8) || null,
         num(4), num(5), num(6), num(7), cell(r, 9) !== 'Нет', i,
         cell(r, 10) || ((cell(r, 3) || 'score') === 'flag' ? 'no' : 'pos')]);
    }
    stat.blocks = (await t.one('SELECT count(*)::int n FROM checklist_blocks')).n;
    stat.items = (await t.one('SELECT count(*)::int n FROM checklist_items')).n;

    // ---------- 3. Справочники ----------
    for (const r of (dump['Тематики'] || []).slice(1)) {
      if (cell(r, 0)) await t.q(`INSERT INTO topics (topic, subtopic) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [cell(r, 0), cell(r, 1)]);
    }
    for (const r of (dump['Города'] || []).slice(1)) {
      if (cell(r, 0)) await t.q(`INSERT INTO cities (city, agglomeration) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [cell(r, 0), cell(r, 1)]);
    }
    let sample = '2';
    for (const r of (dump['Настройки'] || []).slice(1)) {
      if (cell(r, 0) === 'Процент выборки') sample = cell(r, 1) || '2';
    }
    await t.q(`INSERT INTO settings (key, value, note) VALUES ('sample_percent',$1,'Процент прослушки от принятых')
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [sample]);
    stat.topics = (await t.one('SELECT count(*)::int n FROM topics')).n;
    stat.cities = (await t.one('SELECT count(*)::int n FROM cities')).n;

    // ---------- 4. Заявки ----------
    const reqs = dump['Выгрузка звонков'] || [];
    const ST = { 'Новая': 'new', 'В работе': 'in_progress', 'Проверена': 'checked',
                 'Отклонена': 'rejected', 'Без звонка': 'no_call' };
    let nReq = 0;
    for (let i = 1; i < reqs.length; i++) {
      const r = reqs[i];
      if (!cell(r, 0)) continue;
      const op = await t.one(`SELECT id, team FROM staff WHERE full_name = $1`, [cell(r, 2)]);
      if (!op) continue;
      const cd = core.toDateObj(cell(r, 4));
      const rating = cell(r, 10) === '' ? null : Number(cell(r, 10).replace(',', '.'));
      await t.q(`INSERT INTO call_requests
                   (public_id, operator_id, team, call_date, call_time, phone, call_type,
                    status, operator_note, checked_by, rating, qc_comment)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
        [cell(r, 0), op.id, cell(r, 3) || op.team, cd ? core.isoDate(cd) : null,
         cell(r, 5), cell(r, 6), cell(r, 13), ST[cell(r, 7)] || 'new',
         cell(r, 12), cell(r, 8), isNaN(rating) ? null : rating, cell(r, 11)]);
      nReq++;
    }
    stat.requests = nReq;

    // ---------- 5. Журнал оценок ----------
    // 15 метаданных + 12 итогов, дальше пары «пункт / комментарий»
    const jr = dump['Журнал оценок'] || [];
    const itemCodes = (await t.q(`SELECT code FROM checklist_items ORDER BY sort_order`)).map(x => x.code);
    const FIRST_ITEM = 27;
    let nEv = 0, skipped = [];
    for (let i = 1; i < jr.length; i++) {
      const r = jr[i];
      if (!cell(r, 0)) continue;
      const op = await t.one(`SELECT id, team FROM staff WHERE full_name = $1`, [cell(r, 4)]);
      const qc = await t.one(`SELECT id FROM staff WHERE full_name = $1`, [cell(r, 2)]);
      if (!op || !qc) { skipped.push(cell(r, 0) + ' (нет в составе: ' + cell(r, 4) + ' / ' + cell(r, 2) + ')'); continue; }
      const cd = core.toDateObj(cell(r, 6));
      if (!cd) { skipped.push(cell(r, 0) + ' (не разобрана дата)'); continue; }

      const rq = cell(r, 14) ? await t.one(`SELECT id FROM call_requests WHERE public_id=$1`, [cell(r, 14)]) : null;
      const num = v => { const s = cell(r, v); return s === '' ? 0 : Number(s.replace(',', '.')); };
      const yes = v => cell(r, v) === 'Да';

      const ev = await t.one(`
        INSERT INTO evaluations
          (public_id, operator_id, qc_id, request_id, team, call_date, call_time, phone, iso_week,
           criterion, topic, subtopic, city, agglomeration, review_source,
           score, pts_got, pts_max, critical, minor, violation, complaint, gratitude, complaint_mark)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
        ON CONFLICT DO NOTHING RETURNING id`,
        [cell(r, 0), op.id, qc.id, rq ? rq.id : null, cell(r, 5) || op.team,
         core.isoDate(cd), cell(r, 7), cell(r, 8), cell(r, 3) || core.isoWeek(core.isoDate(cd)),
         cell(r, 9), cell(r, 10), cell(r, 11), cell(r, 12), cell(r, 13), cell(r, 24),
         num(15), num(16), num(17), num(18), num(19),
         yes(20), yes(21), yes(22), yes(23)]);
      if (!ev) { skipped.push(cell(r, 0) + ' (дубль)'); continue; }

      const vals = [], params = [];
      let p = 1;
      itemCodes.forEach(function (code, k) {
        const ru = cell(r, FIRST_ITEM + k * 2);
        if (!ru) return;
        const v = core.RU_TO_CODE[ru];
        if (!v || v === 'pos') return;     // положительные не храним
        vals.push(`($${p++},$${p++},$${p++},$${p++})`);
        params.push(ev.id, code, v, cell(r, FIRST_ITEM + k * 2 + 1));
      });
      if (vals.length) {
        await t.q(`INSERT INTO evaluation_answers (evaluation_id, item_code, value, comment)
                   VALUES ${vals.join(',')} ON CONFLICT DO NOTHING`, params);
      }
      nEv++;
    }
    stat.evaluations = nEv;
    stat.skipped = skipped;

    // ---------- 6. Принятые звонки ----------
    let nAcc = 0;
    for (const r of (dump['Принятые звонки'] || []).slice(1)) {
      if (!cell(r, 1)) continue;
      const op = await t.one(`SELECT id FROM staff WHERE full_name=$1`, [cell(r, 1)]);
      const d = core.toDateObj(cell(r, 0));
      if (!op || !d) continue;
      await t.q(`INSERT INTO accepted_calls (stat_date, operator_id, accepted) VALUES ($1,$2,$3)
                 ON CONFLICT (stat_date, operator_id) DO UPDATE SET accepted = EXCLUDED.accepted`,
        [core.isoDate(d), op.id, Number(cell(r, 2)) || 0]);
      nAcc++;
    }
    stat.acceptedCalls = nAcc;
  });

  // ---------- сверка ----------
  console.log('\n=== ПЕРЕНЕСЕНО ===');
  for (const [k, v] of Object.entries(stat)) {
    if (k === 'skipped') continue;
    console.log(`  ${k.padEnd(18)} ${v}`);
  }
  if (stat.skipped && stat.skipped.length) {
    console.log(`\n  пропущено строк журнала: ${stat.skipped.length}`);
    stat.skipped.slice(0, 5).forEach(s => console.log('    ·', s));
  }
  await db.pool.end();
}

main().catch(e => { console.error('ОШИБКА ПЕРЕНОСА:', e.message); process.exit(1); });
