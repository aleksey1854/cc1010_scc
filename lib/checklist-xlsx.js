// ============================================================
// lib/checklist-xlsx.js — чек-лист в том же виде, в каком его
// рассылают по почте.
//
// В КЦ привыкли к макету из «Чек-лист 09.26» (до него — 04.26): слева баллы и влияние
// ошибки, справа результат по каждому пункту, снизу итог и карточка
// звонка. Собирать такой лист заново из кода — гарантированно получить
// «похоже, но не то», поэтому берём их же файл (assets/checklist-template.xlsx)
// и подставляем в него значения. Формулы в макете остаются: Excel сам
// пересчитает баллы и «качество контакта».
//
// Пункты ищем по названию, а поля карточки — по подписям («ФИО оператора:»,
// «Тематика»…), а не по номерам строк: в 09.26 добавили пункт, и всё ниже
// съехало на две строки. Макет можно править, не трогая код.
//
// Баллы пунктов считаем нашими весами, а не формулами макета: в макете за
// «сомнительно» в технике диалога стоит 2 из 3, а на деле (и у нас) 1,5 —
// файл показывал бы не тот итог, что на сайте.
// ============================================================
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const embedded = require('./checklist-template');

// Исходник макета — .xlsx рядом с кодом, но в бандл Vercel едут только
// файлы, видимые через require, и функция его не находила. Поэтому копия
// лежит модулем; локально читаем сам файл, чтобы правки были видны сразу.
const TEMPLATE = path.join(__dirname, '..', 'assets', 'checklist-template.xlsx');

function templateBuffer() {
  try {
    if (fs.existsSync(TEMPLATE)) return fs.readFileSync(TEMPLATE);
  } catch (_) { /* на проде файла нет — это норма */ }
  return Buffer.from(embedded.base64, 'base64');
}

const COL = { points: 1, share: 2, ko: 3, score: 4, text: 5, result: 6, note: 7 };

// подпись в макете (столбец F) → поле карточки; значение — справа, в G
const CARD = [
  ['критерий звонка', 'criterion'], ['тематика', 'topic'], ['подтематика', 'sub'],
  ['фио контролера', 'qc'], ['дата оценки', 'checkedDate'], ['фио оператора', 'operator'],
  ['номер телефона', 'phone'], ['город обращения', 'city'], ['агломерация', 'agg']
];

// формула балла пункта нашими весами: F — ответ в строке r
function pointsFormula(r, options) {
  const pts = {};
  (options || []).forEach(o => { pts[o.value] = o.points; });
  let f = '0';
  for (const [code, ru] of [['na', 'не требуется'], ['neg', 'отрицательно'], ['dbt', 'сомнительно'], ['pos', 'положительно']]) {
    if (pts[code] === undefined || (code === 'neg' && pts[code] === 0)) continue;
    f = 'IF(F' + r + '="' + ru + '",' + pts[code] + ',' + f + ')';
  }
  return f;
}

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
  await wb.xlsx.load(templateBuffer());
  const ws = wb.worksheets[0];

  // строки пунктов: есть название, ответ и формула — балла или отметки
  // («Признак жалобы» ставит только галочку). У заголовка блока нет
  // ответа, у шапки — формул
  const isFormula = v => !!(v && typeof v === 'object' && (v.formula || v.sharedFormula));
  const rowByItem = new Map();
  let totalRow = 0;
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const text = cellText(row.getCell(COL.text));
    const hasFormula = isFormula(row.getCell(COL.score).value) || isFormula(row.getCell(COL.ko).value);
    if (text && hasFormula && row.getCell(COL.result).value != null) rowByItem.set(norm(text), r);
    if (!totalRow && /^качество контакта/.test(norm(cellText(row.getCell(COL.share))))) totalRow = r;
  }

  const missed = [];
  for (const it of items) {
    const r = rowByItem.get(norm(it.text));
    if (!r) { missed.push(it.text); continue; }
    // пункта при оценке не было — ответ пустой, а не «положительно» из макета
    ws.getRow(r).getCell(COL.result).value = it.result ? templateValue(it.result, it.kind) : null;
    if (it.comment) ws.getRow(r).getCell(COL.note).value = it.comment;
    if (it.kind !== 'flag' && it.options) ws.getRow(r).getCell(COL.score).value = { formula: pointsFormula(r, it.options) };
  }

  // Оценка по прошлой версии чек-листа (другой максимум): формулы макета
  // посчитали бы её по новым правилам. Итог ставим тот, что на сайте.
  if (totalRow && ev.ptsMax && ev.maxTotal && ev.ptsMax !== ev.maxTotal && typeof ev.score === 'number') {
    const cell = ws.getRow(totalRow).getCell(COL.score);
    cell.value = ev.score / 100;
    cell.note = 'Оценено по прошлой версии чек-листа (из ' + ev.ptsMax + ' баллов) — итог как на сайте';
  }

  // карточка звонка: сверху описание, снизу кто и когда слушал
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const e = norm(cellText(row.getCell(COL.text)));
    if (/^дата звонка/.test(e)) row.getCell(COL.text).value = 'Дата звонка: ' + (ev.callDate || '');
    if (/^время звонка/.test(e)) row.getCell(COL.text).value = 'Время звонка: ' + (ev.callTime || '');
    const label = norm(cellText(row.getCell(COL.result))).replace(/:$/, '');
    const hit = CARD.find(c => c[0] === label);
    if (hit) row.getCell(COL.note).value = ev[hit[1]] || '';
  }

  // от кого жалоба — в макете такого поля нет, пишем в примечание к пункту
  if (ev.complaintSource) {
    const r = rowByItem.get(norm('Признак жалобы в чек-листе'));
    if (r) {
      const cell = ws.getRow(r).getCell(COL.note);
      const had = cellText(cell);
      cell.value = (had ? had + ' · ' : '') + 'Жалоба от: ' + ev.complaintSource;
    }
  }

  // В макете у каждой формулы лежит посчитанное значение из шаблона —
  // там всё «положительно» и 100%. Excel показывает именно его, пока не
  // пересчитает, и человек видел чужой балл. Снимаем кеш и просим Excel
  // пересчитать всё при открытии.
  ws.eachRow({ includeEmpty: false }, row => {
    row.eachCell({ includeEmpty: false }, cell => {
      const v = cell.value;
      if (v && typeof v === 'object' && (v.formula || v.sharedFormula)) {
        cell.value = v.formula
          ? { formula: v.formula }
          : { sharedFormula: v.sharedFormula, ref: v.ref };
      }
    });
  });
  wb.calcProperties = wb.calcProperties || {};
  wb.calcProperties.fullCalcOnLoad = true;

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

module.exports = { evaluationFile, evaluationWorkbook, templateBuffer, TEMPLATE };
