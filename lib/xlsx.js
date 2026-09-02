// ============================================================
// lib/xlsx.js — выгрузки настоящим файлом Excel, а не CSV.
//
// CSV Excel открывал как придётся: кириллица превращалась в кракозябры,
// всё лезло в одну колонку, ширину приходилось растягивать руками.
// Здесь готовый лист: шапка выделена и закреплена, включён фильтр,
// колонки уже по ширине содержимого, проценты — числа, а не текст.
// ============================================================
const ExcelJS = require('exceljs');

const HEAD_FILL = 'FF2B59F0';     // тот же синий, что в интерфейсе
const BORDER = 'FFE4E8F0';

// Колонка: { header, key, width?, numFmt?, align? }
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
  wb.creator = 'КЦ1010';
  wb.created = new Date();

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name.slice(0, 31), {
      views: [{ state: 'frozen', ySplit: 1 }]          // шапка не уезжает при прокрутке
    });

    ws.columns = sheet.columns.map(c => ({
      header: c.header,
      key: c.key,
      width: c.width || autoWidth(c.header, sheet.rows, c.key)
    }));

    ws.addRows(sheet.rows);

    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_FILL } };
    head.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    head.height = 24;

    sheet.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      if (c.numFmt) col.numFmt = c.numFmt;
      if (c.align) col.alignment = { horizontal: c.align, vertical: 'top' };
      else col.alignment = { vertical: 'top', wrapText: c.wrap === true };
    });

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

// Отчёт целиком: имя файла, лист и колонки
async function sheet(filename, name, columns, rows) {
  return {
    success: true,
    filename: filename.replace(/\.csv$/, '') + '.xlsx',
    contentBase64: await build([{ name, columns, rows }]),
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
}

module.exports = { build, sheet };
