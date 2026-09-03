// ============================================================
// scripts/clean-names.js — привести ФИО в составе в порядок.
//
// В выгрузках звонков ФИО набирали руками: где-то строчными, где-то
// с приклеенным телефоном. Из-за этого человек не узнавался при загрузке
// статистики принятых звонков и криво выглядел в списках.
//
// Трогаем только очевидное: убираем цифры и лишние пробелы, поднимаем
// регистр у слов, набранных целиком строчными. Инициалы («Финк Е.Г.»)
// и приставки («кызы», «оглы») оставляем как есть — гадать не надо.
//
//   DATABASE_URL=... node scripts/clean-names.js [--apply]
// ============================================================
const db = require('../lib/db');

const KEEP = ['кызы', 'гызы', 'оглы', 'углы', 'уулу'];

function clean(name) {
  return String(name || '')
    .replace(/[0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(w => {
      if (KEEP.indexOf(w.toLowerCase()) >= 0) return w.toLowerCase();
      if (w.indexOf('.') >= 0) return w;                 // инициалы не трогаем
      if (w !== w.toLowerCase()) return w;               // уже с заглавной
      return w.split('-').map(x => x ? x[0].toUpperCase() + x.slice(1) : x).join('-');
    })
    .join(' ');
}

async function main() {
  const apply = process.argv.indexOf('--apply') >= 0;
  const rows = await db.q(`SELECT id, full_name FROM staff ORDER BY full_name`);
  const fix = rows.map(r => [r, clean(r.full_name)]).filter(([r, c]) => c !== r.full_name && c);

  console.log(apply ? '=== ПРАВИМ ===' : '=== ЧТО БЫ ПОМЕНЯЛОСЬ (нужен --apply) ===');
  for (const [r, c] of fix) {
    console.log('  «' + r.full_name + '» → «' + c + '»');
    if (!apply) continue;
    await db.q(`UPDATE staff SET full_name=$2, updated_at=now() WHERE id=$1`, [r.id, c]);
    // имя в заявках и истории хранится строкой — правим и там
    await db.q(`UPDATE call_requests SET checked_by=$2 WHERE checked_by=$1`, [r.full_name, c]);
    await db.q(`UPDATE request_events SET actor_name=$2 WHERE actor_name=$1`, [r.full_name, c]);
  }
  console.log('  всего: ' + fix.length + ' из ' + rows.length);
  await db.pool.end();
}

main().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
