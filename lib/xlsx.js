// ============================================================
// lib/xlsx.js — выгрузки настоящим файлом Excel, а не CSV.
//
// CSV Excel открывал как придётся: кириллица превращалась в кракозябры,
// всё лезло в одну колонку, ширину приходилось растягивать руками.
// Здесь готовый лист: шапка выделена и закреплена, включён фильтр,
// колонки уже по ширине содержимого, проценты — числа, а не текст.
//
// Оформление снято с их собственных файлов («Чек-лист 04.26», отчёт по
// жалобам): бирюзовая шапка белым по жирному, оранжевые строки итогов,
// Arial и тонкая сетка. Свой синий выглядел чужеродно рядом с остальной
// отчётностью КЦ.
// ============================================================
const ExcelJS = require('exceljs');

const HEAD_FILL = 'FF009999';     // бирюза из их бланков
const TOTAL_FILL = 'FFFFCC99';    // оранжевый — строки итогов
const BORDER = 'FF9AA5B1';
const FONT = 'Arial';

// Колонка: { header, key, width?, numFmt?, align?, fill?, pct? }
// pct — в строках проценты (98.35), а в ячейку пишем долю (0.9835) под
// форматом '0.00%': Excel видит настоящий процент, и смена формата руками
// не превращает 100,00% в 10000%.
// fill — заливка тела колонки (ARGB), нужна там, где колонку выделяют
// цветом: КЗ от заказчика идут фиолетовым, как в отчёте на экране.
// Ширину не задали — считаем по самому длинному значению.
function autoWidth(header, rows, key) {
  let max = String(header).length;
  for (const r of rows) {
    const v = r[key];
    const len = v === null || v === undefined ? 0 : String(v).length;
    if (len > max) max = len;
  }
  return Math.min(60, Math.max(9, max + 3));
}

async function build(sheets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CallAudit1010';
  wb.created = new Date();

  for (const sheet of sheets) {
    // шапка не уезжает при прокрутке; freezeCols — и первые столбцы (кто и
    // когда), чтобы при прокрутке вправо по пунктам было видно, чья оценка
    const ws = wb.addWorksheet(sheet.name.slice(0, 31), {
      views: [{ state: 'frozen', xSplit: sheet.freezeCols || 0, ySplit: 1 }]
    });

    ws.columns = sheet.columns.map(c => ({
      header: c.header,
      key: c.key,
      width: c.width || autoWidth(c.header, sheet.rows, c.key)
    }));

    ws.addRows(sheet.rows);

    sheet.columns.forEach((c, i) => {
      if (!c.pct) return;
      const col = ws.getColumn(i + 1);
      col.eachCell((cell, r) => {
        if (r > 1 && typeof cell.value === 'number') cell.value = Math.round(cell.value * 100) / 10000;
      });
    });

    const head = ws.getRow(1);
    head.font = { name: FONT, bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_FILL } };
    head.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    head.height = sheet.headHeight || 30;          // длинные названия пунктов — выше

    sheet.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      if (c.numFmt) col.numFmt = c.numFmt;
      if (c.align) col.alignment = { horizontal: c.align, vertical: 'top' };
      else col.alignment = { vertical: 'top', wrapText: c.wrap === true };
    });

    // Тело — тем же Arial, что в их бланках; итоговые строки оранжевые,
    // как «Всего жалоб» и «Итого по группе» в исходных отчётах.
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const total = sheet.rows[r - 2] && sheet.rows[r - 2].__total;
      row.font = { name: FONT, size: 10, bold: !!total };
      if (total) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } };
      } else {
        const src = sheet.rows[r - 2] || {};
        sheet.columns.forEach((c, i) => {
          // заливка отдельной ячейки (__fill[key]) главнее заливки колонки
          const f = (src.__fill && src.__fill[c.key]) || c.fill;
          if (f) {
            ws.getCell(r, i + 1).fill =
              { type: 'pattern', pattern: 'solid', fgColor: { argb: f } };
          }
          // примечание к ячейке (__notes[key]) — видно при наведении
          if (src.__notes && src.__notes[c.key]) ws.getCell(r, i + 1).note = String(src.__notes[c.key]);
        });
      }
    }

    // тонкая сетка: без неё длинные таблицы читаются тяжело
    const last = ws.rowCount, cols = sheet.columns.length;
    for (let r = 1; r <= last; r++) {
      for (let c = 1; c <= cols; c++) {
        ws.getCell(r, c).border = {
          top: { style: 'thin', color: { argb: BORDER } },
          left: { style: 'thin', color: { argb: BORDER } },
          bottom: { style: 'thin', color: { argb: BORDER } },
          right: { style: 'thin', color: { argb: BORDER } }
        };
      }
    }

    if (last > 1) {
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols } };
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
}

// Лист «как в их таблице»: строки массивами, без нашей бирюзовой шапки.
// Нужен там, где выгрузку вставляют в их собственные книги: порядок
// столбцов, служебная строка номеров, форматы и ширины — один в один.
// opts: { widths[], formats{номер столбца: numFmt}, dataFrom (первая строка
//         данных), freeze{x,y}, heights{номер строки: высота}, rowHeight }
async function plainSheet(filename, name, rows, opts) {
  const o = opts || {};
  const dataFrom = o.dataFrom || 2;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CallAudit1010';
  wb.created = new Date();
  const ws = wb.addWorksheet(name.slice(0, 31), {
    views: [{ state: 'frozen', xSplit: (o.freeze && o.freeze.x) || 0, ySplit: (o.freeze && o.freeze.y) || 0 }]
  });
  (o.widths || []).forEach((w, i) => { if (w) ws.getColumn(i + 1).width = w; });
  const fmts = o.formats || {};
  rows.forEach((vals, ri) => {
    const rn = ri + 1;
    const row = ws.getRow(rn);
    row.height = (o.heights && o.heights[rn]) || o.rowHeight || 23.25;
    vals.forEach((v, ci) => {
      if (v === undefined || v === null || v === '') return;
      const cell = row.getCell(ci + 1);
      cell.value = v;
      cell.font = { name: 'Calibri', size: 11 };
      if (rn >= dataFrom) {
        cell.alignment = { horizontal: 'center', vertical: 'bottom' };
        if (fmts[ci + 1]) cell.numFmt = fmts[ci + 1];
      }
    });
  });
  const buf = await wb.xlsx.writeBuffer();
  return {
    success: true,
    filename: filename.replace(/\.csv$/, '') + '.xlsx',
    contentBase64: Buffer.from(buf).toString('base64'),
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
}

// Отчёт целиком: имя файла, лист и колонки; opts — { freezeCols, headHeight }
async function sheet(filename, name, columns, rows, opts) {
  return {
    success: true,
    filename: filename.replace(/\.csv$/, '') + '.xlsx',
    contentBase64: await build([Object.assign({ name, columns, rows }, opts || {})]),
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
}

module.exports = { build, sheet, plainSheet };
