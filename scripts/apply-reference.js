// ============================================================
// scripts/apply-reference.js — обновление справочников на живой базе.
//
// Меняет чек-лист и тематики, не трогая сотрудников, заявки и оценки:
// после правок в оригинальных таблицах не нужно сносить базу целиком.
//
// Пункты, которых больше нет, не удаляются, а гасятся (active=false):
// иначе старые оценки потеряли бы формулировки своих ошибок.
//
//   DATABASE_URL=... node scripts/apply-reference.js
//   DATABASE_URL=... node scripts/apply-reference.js --dry
// ============================================================
const db = require('../lib/db');
const { CHECKLIST, TOPICS, CITIES, DEFAULTS } = require('./seed');

const dry = process.argv.includes('--dry');

async function main() {
  const stat = { блоков: 0, пунктов: 0, погашено: 0, тематик: 0, городов: 0 };

  await db.tx(async (t) => {
    // ---------- чек-лист ----------
    const codes = [];
    let bOrder = 0, iOrder = 0;

    for (const [bcode, bname, items] of CHECKLIST) {
      bOrder++;
      await t.q(`INSERT INTO checklist_blocks (code, name, sort_order) VALUES ($1,$2,$3)
                 ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order`,
        [bcode, bname, bOrder]);
      stat.блоков++;

      for (const [code, text, pos, dbt, neg, na, kind, rule] of items) {
        iOrder++;
        codes.push(code);
        await t.q(`
          INSERT INTO checklist_items
            (block_id, code, text, kind, rule, pts_pos, pts_dbt, pts_neg, pts_na, active, sort_order, default_value)
          VALUES ((SELECT id FROM checklist_blocks WHERE code=$1),$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11)
          ON CONFLICT (code) DO UPDATE SET
            block_id = EXCLUDED.block_id, text = EXCLUDED.text, kind = EXCLUDED.kind,
            rule = EXCLUDED.rule, pts_pos = EXCLUDED.pts_pos, pts_dbt = EXCLUDED.pts_dbt,
            pts_neg = EXCLUDED.pts_neg, pts_na = EXCLUDED.pts_na,
            active = true, sort_order = EXCLUDED.sort_order,
            default_value = EXCLUDED.default_value`,
          [bcode, code, text, kind || 'score', rule || null, pos, dbt, neg, na, iOrder,
           DEFAULTS[code] || (kind === 'flag' ? 'no' : 'pos')]);
        stat.пунктов++;
      }
    }

    const off = await t.q(`UPDATE checklist_items SET active = false
                            WHERE active AND NOT (code = ANY($1)) RETURNING code`, [codes]);
    stat.погашено = off.length;
    stat.погашенные = off.map(r => r.code);

    // ---------- тематики ----------
    await t.q(`DELETE FROM topics`);
    for (const [topic, sub] of TOPICS) {
      await t.q(`INSERT INTO topics (topic, subtopic) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [topic, sub || '']);
    }
    stat.тематик = (await t.one(`SELECT count(*)::int n FROM topics`)).n;

    // ---------- города ----------
    // Список нужен как подсказка и чтобы агломерация подставлялась сама;
    // вписать в поле можно что угодно, справочник не ограничивает.
    await t.q(`DELETE FROM cities`);
    for (const [city, agg] of CITIES) {
      await t.q(`INSERT INTO cities (city, agglomeration) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [city, agg || '']);
    }
    stat.городов = (await t.one(`SELECT count(*)::int n FROM cities`)).n;

    if (dry) throw new Error('--dry: откатываем, ничего не записано');
  }).catch(e => {
    if (!dry || !/--dry/.test(e.message)) throw e;
  });

  db.dropChecklistCache();
  const cfg = await db.getChecklist(true);
  console.log(dry ? '=== ПРОБНЫЙ ПРОГОН (ничего не записано) ===' : '=== СПРАВОЧНИКИ ОБНОВЛЕНЫ ===');
  for (const [k, v] of Object.entries(stat)) {
    if (k === 'погашенные') continue;
    console.log('  ' + k.padEnd(12) + v);
  }
  if (stat.погашено) console.log('  погашены:   ' + stat.погашенные.join(', '));
  console.log('  максимум:   ' + cfg.maxTotal + ' баллов');
  cfg.blocks.forEach(b => console.log('    ' + b.name + ' — ' + b.max + ' б., пунктов: ' + b.items.length));
  await db.pool.end();
}

main().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
