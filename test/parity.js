// Сверка переноса: новое ядро против старого Apps Script.
// Если хоть одна цифра сдвинулась — переезд сломал расчёт.
// Сверка требует финальную версию Apps Script (8 файлов .gs) рядом,
// в /home/claude/qc. Без неё тест пропускается — это не провал.
const OLD = process.env.OLD_PROJECT || '/home/claude/qc/test/harness';
try { require.resolve(OLD); } catch {
  console.log('ПРОПУЩЕН: не найден старый проект (' + OLD + ').');
  console.log('Задайте OLD_PROJECT, если нужна сверка паритета.');
  process.exit(0);
}
const core = require('../lib/core');
const { buildCtx } = require(OLD);
const fs = require('fs');
let bad = [];
const chk = (n, c, d) => { if (c) console.log('  ✓', n); else { console.log('  ✗', n, d !== undefined ? '→ ' + JSON.stringify(d) : ''); bad.push(n); } };

const old = buildCtx(JSON.parse(fs.readFileSync('/tmp/from_xlsx.json', 'utf8')));
old._MEM = {};
const oldCfg = old.getChecklistConfig_();

// переводим конфиг старого формата в новый (русские значения → коды)
const cfg = { blocks: oldCfg.blocks.map(b => ({
  code: b.name.split('.')[0], name: b.name, max: b.max,
  items: b.items.map(i => ({
    code: i.id, kind: i.type, rule: i.rule, text: i.text,
    options: (i.options || []).map(o => ({ value: core.RU_TO_CODE[o.value] || o.value, points: o.points }))
  }))
}))};

console.log('━━━ ХЕШИ ПАРОЛЕЙ ━━━');
const h = old.hashPassword_('parol12345');
chk('хеш из Apps Script проходит проверку в Node', core.verifyPassword('parol12345', h));
chk('неверный пароль отвергается', !core.verifyPassword('parol12346', h));
const h2 = core.hashPassword('parol12345');
chk('хеш из Node проходит проверку в Apps Script', old.verifyPassword_('parol12345', h2));
chk('формат хеша не изменился', /^sha256\$1200\$[0-9a-f]{16}\$/.test(h2), h2.slice(0, 30));

console.log('\n━━━ РАСЧЁТ БАЛЛА: 5000 СЛУЧАЙНЫХ ЧЕК-ЛИСТОВ ━━━');
let seed = 20260816;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const RU = ['Положительно', 'Сомнительно', 'Отрицательно', 'Не требуется', ''];
let diff = [], maxD = 0, seen = new Set();
for (let k = 0; k < 5000; k++) {
  const ruAns = {}, codeAns = {};
  oldCfg.blocks.forEach(b => b.items.forEach(it => {
    if (it.type === 'flag') { if (rnd() < 0.05) { ruAns[it.id] = 'Обнаружено'; codeAns[it.id] = 'yes'; } return; }
    const v = RU[Math.floor(rnd() * RU.length)];
    if (v) { ruAns[it.id] = v; codeAns[it.id] = core.RU_TO_CODE[v]; }
  }));
  const a = old.computeScore_(oldCfg, ruAns);
  const b = core.computeScore(cfg, codeAns);
  seen.add(a.score);
  for (const f of ['score', 'got', 'max', 'critical', 'minor', 'violation', 'complaint', 'gratitude']) {
    if (a[f] !== b[f]) { if (diff.length < 3) diff.push({ поле: f, старое: a[f], новое: b[f] }); }
  }
  maxD = Math.max(maxD, Math.abs(a.score - b.score));
}
chk('все поля совпали на 5000 наборах', diff.length === 0, diff);
chk('расхождение балла = 0', maxD === 0, maxD);
console.log('     различных значений итога:', seen.size);

console.log('\n━━━ ДАТЫ ━━━');
let iso = [], mb = [];
for (let y = 2023; y <= 2027; y++) for (let m = 1; m <= 12; m++) for (let d = 1; d <= 31; d++) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) continue;
  const s = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  if (old.isoWeek_(s) !== core.isoWeek(s)) iso.push(s);
}
chk('ISO-неделя совпала на 1826 датах', iso.length === 0, iso.slice(0, 3));
const REF = new Date(2026, 7, 16);
for (let d = 0; d <= 1400; d++) {
  const hd = new Date(REF.getTime() - d * 86400000);
  if (old.monthsBetween_(hd, REF) !== core.monthsBetween(hd, REF)) mb.push(d);
}
chk('стаж совпал на 1401 дате', mb.length === 0, mb.slice(0, 3));
['2026-08-16', '16.08.2026', '2026-1-5'].forEach(s =>
  chk('разбор даты «' + s + '»', core.isoDate(old.toDateObj_(s)) === core.isoDate(core.toDateObj(s))));

console.log('\n━━━ ПРОЧЕЕ ━━━');
chk('транслитерация ФИО', core.suggestLogin('Иванов Иван', {}) === 'ivanov.i');
chk('казахские буквы', core.suggestLogin('Әбдіғали Қуаныш', {}) === 'abdigali.k', core.suggestLogin('Әбдіғали Қуаныш', {}));
chk('коллизия логина разводится цифрой', core.suggestLogin('Иванов Иван', {'ivanov.i': 1}) === 'ivanov.i2');
[['77011234567','77011234567'],['87011234567','77011234567'],['7011234567','77011234567'],['мусор',null]]
  .forEach(([i, o]) => chk('телефон «' + i + '»', core.normPhone(i) === o, core.normPhone(i)));
chk('слабый пароль опознан', core.isWeakPass('111111') && core.isWeakPass('qwerty') && !core.isWeakPass('Xk9mZq2rT'));
chk('pct2 формат', core.pct2(91.11) === '91,11%' && core.pct2(undefined) === '—');

// ---------- макет чек-листа ----------
// Проверяем не базу, а сам механизм: пункты ищутся по названию, значения
// ложатся в колонку «Результат», карточка звонка — в шапку и подвал.
(async () => {
  const tpl = require('../lib/checklist-xlsx');
  const items = [
    { text: 'Приветствие', kind: 'score', result: 'Отрицательно', comment: 'не представился' },
    { text: 'Прощание', kind: 'score', result: 'Не требуется' },
    { text: 'Подтверждённая жалоба', kind: 'flag', result: 'Обнаружено' },   // в макете без «ё»
    { text: 'Такого пункта нет', kind: 'score', result: 'Положительно' }
  ];
  const { wb, missed } = await tpl.evaluationWorkbook({
    callDate: '04.09.2026', callTime: '11:20', criterion: 'Длит: средний (3-5 мин)',
    topic: 'Анализы', sub: 'Запись', qc: 'Контролёр К.', checkedDate: '05.09.2026',
    operator: 'Оператор О.', phone: '79161234567', city: 'Москва', agg: 'Москва',
    complaintSource: 'Клиент'
  }, items);
  const ws = wb.worksheets[0];
  const at = a => {
    const v = ws.getCell(a).value;
    return v && v.richText ? v.richText.map(t => t.text).join('') : v;
  };

  console.log('\n\u2501\u2501\u2501 МАКЕТ ЧЕК-ЛИСТА \u2501\u2501\u2501');
  // зашитая копия макета должна совпадать с файлом, иначе на проде уедет
  // старый бланк, а локально всё будет выглядеть правильно
  const crypto = require('crypto'), fsx = require('fs');
  const embedded = require('../lib/checklist-template');
  chk('зашитый макет совпадает с assets/checklist-template.xlsx',
    crypto.createHash('sha256').update(fsx.readFileSync(tpl.TEMPLATE)).digest('hex') === embedded.sha256,
    'перегенерируйте: node scripts/embed-template.js');

  chk('не найден только несуществующий пункт',
    missed.length === 1 && missed[0] === 'Такого пункта нет', missed);
  chk('результат встал в строку пункта', at('F4') === 'отрицательно', at('F4'));
  chk('комментарий рядом с пунктом', at('G4') === 'не представился', at('G4'));
  chk('«не требуется» строчными', at('F5') === 'не требуется', at('F5'));
  chk('«ё» не мешает сопоставлению', at('F32') === 'Обнаружено', at('F32'));
  chk('дата звонка в шапке', at('E1') === 'Дата звонка: 04.09.2026', at('E1'));
  chk('критерий в шапке', at('G1') === 'Длит: средний (3-5 мин)', at('G1'));
  chk('контролёр в подвале', at('G39') === 'Контролёр К.', at('G39'));
  chk('город в подвале', at('G43') === 'Москва', at('G43'));
  chk('источник жалобы записан', String(at('G33') || '').includes('Клиент'), at('G33'));
  chk('формулы на месте',
    !!(ws.getCell('D4').value && ws.getCell('D4').value.formula), ws.getCell('D4').value);

  console.log('\nПРОВАЛЕНО: ' + bad.length);
  bad.forEach(b => console.log('   \u00b7', b));
  process.exit(bad.length ? 1 : 0);
})();
