// ============================================================
// lib/checklist-xlsx.js — чек-лист в том же виде, в каком его
// рассылают по почте.
//
// В КЦ привыкли к макету из «Чек-лист 04.26»: слева баллы и влияние
// ошибки, справа результат по каждому пункту, снизу итог и карточка
// звонка. Собирать такой лист заново из кода — гарантированно получить
// «похоже, но не то», поэтому берём их же файл (assets/checklist-template.xlsx)
// и подставляем в него значения. Формулы в макете остаются: Excel сам
// пересчитает баллы и «качество контакта».
//
// Пункты ищем по названию, а не по номеру строки: макет можно править,
// не трогая код.
// ============================================================
const path = require('path');
const ExcelJS = require('exceljs');

const TEMPLATE = path.join(__dirname, '..', 'assets', 'checklist-template.xlsx');

const COL = { points: 1, share: 2, ko: 3, score: 4, text: 5, result: 6, note: 7 };
const FIRST_ROW = 3, LAST_ROW = 40;

// «Подтверждённая жалоба» в базе и «Подтвержденная жалоба» в макете —
// одно и то же
const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

function cellText(cell) {
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
  return '';
}

// в макете результаты набраны строчными, события — с заглавной
function templateValue(ru, kind) {
  const s = String(ru || '');
  if (kind === 'flag') return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * @param {object} ev   карточка звонка: operator, qc, callDate, callTime, phone,
 *                      criterion, topic, sub, city, agg, checkedDate
 * @param {Array}  items [{ text, kind, result, comment }]
 */
async function evaluationWorkbook(ev, items) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const ws = wb.worksheets[0];

  const rowByItem = new Map();
  for (let r = FIRST_ROW; r <= LAST_ROW; r++) {
    const row = ws.getRow(r);
    const text = cellText(row.getCell(COL.text));
    // у заголовка блока колонка «Результат» пустая — он нам не нужен
    if (text && row.getCell(COL.result).value != null) rowByItem.set(norm(text), r);
  }

  const missed = [];
  for (const it of items) {
    const r = rowByItem.get(norm(it.text));
    if (!r) { missed.push(it.text); continue; }
    ws.getRow(r).getCell(COL.result).value = templateValue(it.result, it.kind);
    if (it.comment) ws.getRow(r).getCell(COL.note).value = it.comment;
  }

  // карточка звонка: сверху описание, снизу кто и когда слушал
  ws.getCell('E1').value = 'Дата звонка: ' + (ev.callDate || '');
  ws.getCell('E2').value = 'Время звонка: ' + (ev.callTime || '');
  ws.getCell('G1').value = ev.criterion || '';
  ws.getCell('G2').value = ev.topic || '';
  ws.getCell('H2').value = ev.sub || '';
  ws.getCell('G39').value = ev.qc || '';
  ws.getCell('G40').value = ev.checkedDate || '';
  ws.getCell('G41').value = ev.operator || '';
  ws.getCell('G42').value = ev.phone || '';
  ws.getCell('G43').value = ev.city || '';
  ws.getCell('G44').value = ev.agg || '';

  // от кого жалоба — в макете такого поля нет, пишем в примечание к пункту
  if (ev.complaintSource) {
    const r = rowByItem.get(norm('Признак жалобы в чек-листе'));
    if (r) {
      const cell = ws.getRow(r).getCell(COL.note);
      const had = cellText(cell);
      cell.value = (had ? had + ' · ' : '') + 'Жалоба от: ' + ev.complaintSource;
    }
  }

  return { wb, missed };
}

async function evaluationFile(ev, items, filename) {
  const { wb, missed } = await evaluationWorkbook(ev, items);
  const buf = await wb.xlsx.writeBuffer();
  return {
    success: true,
    filename: (filename || 'checklist') + '.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    contentBase64: Buffer.from(buf).toString('base64'),
    missed
  };
}

module.exports = { evaluationFile, evaluationWorkbook, TEMPLATE };
