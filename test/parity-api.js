// ============================================================
// test/parity-api.js — САМАЯ ВАЖНАЯ ПРОВЕРКА ПЕРЕЕЗДА.
//
// Одни и те же данные загружены в Apps Script (заглушки листов)
// и в Postgres. Каждая функция вызывается в обеих системах,
// ответы сравниваются поле в поле. Цель переезда — паритет,
// значит любое расхождение — ошибка переноса.
// ============================================================
// Сверка требует финальную версию Apps Script (8 файлов .gs) рядом,
// в /home/claude/qc. Без неё тест пропускается — это не провал.
const OLD = process.env.OLD_PROJECT || '/home/claude/qc/test/harness';
try { require.resolve(OLD); } catch {
  console.log('ПРОПУЩЕН: не найден старый проект (' + OLD + ').');
  console.log('Задайте OLD_PROJECT, если нужна сверка паритета.');
  process.exit(0);
}
const api = require('../lib/api');
const db = require('../lib/db');
const { buildCtx } = require(OLD);
const fs = require('fs');

let bad = [], checks = 0;
function chk(n, c, d) {
  checks++;
  if (c) console.log('  ✓', n);
  else { console.log('  ✗', n, d !== undefined ? '→ ' + JSON.stringify(d).slice(0, 260) : ''); bad.push(n); }
}
function head(t) { console.log('\n━━━ ' + t + ' ━━━'); }

// Глубокое сравнение с понятным путём до расхождения
function diff(a, b, path, out) {
  if (out.length > 4) return out;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) { out.push({ путь: path, старое: a, новое: b }); return out; }
  if (ta === 'array') {
    if (a.length !== b.length) { out.push({ путь: path + '.length', старое: a.length, новое: b.length }); return out; }
    for (let i = 0; i < a.length; i++) diff(a[i], b[i], path + '[' + i + ']', out);
    return out;
  }
  if (ta === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diff(a[k], b[k], path ? path + '.' + k : k, out);
    return out;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > 0.005) out.push({ путь: path, старое: a, новое: b });
    return out;
  }
  if (a !== b) out.push({ путь: path, старое: a, новое: b });
  return out;
}

(async () => {
  require('./reset')();     // чистая база на каждый прогон

  const dump = JSON.parse(fs.readFileSync('/tmp/dump.json', 'utf8'));
  const creds = JSON.parse(fs.readFileSync('/tmp/generated.json', 'utf8')).creds;
  const old = buildCtx(dump);

  const OP   = creds.find(x => x[2] === 'operator' && x[1] === 'ИНВ-1');
  const QC   = creds.find(x => x[2] === 'qc');
  const RGO  = creds.find(x => x[2] === 'rgo' && x[1] === 'ИНВ-1');
  const SRGO = creds.find(x => x[2] === 'srgo');
  const MGR  = creds.find(x => x[2] === 'manager');
  const ADM  = creds.find(x => x[2] === 'admin');

  // токены в обеих системах
  const oldTok = p => { old._MEM = {}; return old.login(p[3], p[4]).token; };
  const newTok = async p => (await api.call('login', [p[3], p[4]])).token;

  head('ВХОД');
  for (const p of [OP, QC, RGO, SRGO, MGR, ADM]) {
    const a = (old._MEM = {}, old.login(p[3], p[4]));
    const b = await api.call('login', [p[3], p[4]]);
    chk('вход ' + p[2] + ' (' + p[3] + ')',
      a.success === b.success && a.fullName === b.fullName && a.role === b.role && a.group === b.group,
      { старое: { r: a.role, g: a.group }, новое: { r: b.role, g: b.group } });
  }
  const wrong = await api.call('login', [OP[3], 'nevernyy123']);
  chk('неверный пароль отклонён', wrong.success === false, wrong);
  const noSess = await api.call('getRgoDashboard', ['T-нетакого', 'all']);
  chk('поддельный токен отклонён', noSess.success === false, noSess);

  const T = {
    op: { old: oldTok(OP), nw: await newTok(OP) },
    qc: { old: oldTok(QC), nw: await newTok(QC) },
    rgo: { old: oldTok(RGO), nw: await newTok(RGO) },
    srgo: { old: oldTok(SRGO), nw: await newTok(SRGO) },
    mgr: { old: oldTok(MGR), nw: await newTok(MGR) },
    adm: { old: oldTok(ADM), nw: await newTok(ADM) }
  };

  // ------------------------------------------------------------
  async function compare(label, who, fn, newFn, ignore) {
    old._MEM = {};
    let a, b;
    try { a = fn(T[who].old); } catch (e) { chk(label + ' (старое упало)', false, e.message); return; }
    try { b = await (newFn || fn)(T[who].nw, true); } catch (e) { chk(label + ' (новое упало)', false, e.message); return; }
    // ID и отметки времени каждая система генерирует сама — сравнивать их
    // бессмысленно. Приводим к единому виду, всё остальное сверяется строго.
    const norm = v => JSON.parse(JSON.stringify(v)
      .replace(/"(REQ|EV)-[A-Z0-9]+"/g, '"$1-*"')
      .replace(/"\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}"/g, '"<время>"'));
    const strip = o => {
      const c = norm(o);
      (ignore || []).forEach(k => { delete c[k]; });
      return c;
    };
    const d = diff(strip(a), strip(b), '', []);
    chk(label, d.length === 0, d);
  }

  head('СПРАВОЧНИК ЧЕК-ЛИСТА');
  old._MEM = {};
  const cfgA = old.getChecklistConfig_();
  const cfgB = await api.call('getChecklistConfig', [T.qc.nw]);
  chk('9 блоков', cfgA.blocks.length === cfgB.blocks.length, { a: cfgA.blocks.length, b: cfgB.blocks.length });
  chk('максимум 90', cfgA.maxTotal === cfgB.maxTotal, { a: cfgA.maxTotal, b: cfgB.maxTotal });
  chk('максимумы блоков совпали',
    cfgA.blocks.map(x => x.max).join('/') === cfgB.blocks.map(x => x.max).join('/'),
    { a: cfgA.blocks.map(x => x.max).join('/'), b: cfgB.blocks.map(x => x.max).join('/') });
  chk('пункты и их id совпали',
    JSON.stringify(cfgA.blocks.flatMap(x => x.items.map(i => i.id))) ===
    JSON.stringify(cfgB.blocks.flatMap(x => x.items.map(i => i.id))));
  chk('варианты ответа на русском', cfgB.blocks[0].items[0].options.every(o => /[А-Яа-я]/.test(o.value)),
    cfgB.blocks[0].items[0].options);
  chk('тематики и города', cfgA.topics.length === cfgB.topics.length && cfgA.cities.length === cfgB.cities.length);
  // Выборочная сверка пропустила отсутствие callCriteria и block —
  // сравниваем ВЕСЬ набор ключей, включая вложенные.
  chk('набор ключей конфига совпал',
    Object.keys(cfgA).sort().join(',') === Object.keys(cfgB).sort().join(','),
    { старое: Object.keys(cfgA).sort(), новое: Object.keys(cfgB).sort() });
  chk('ключи блока совпали',
    Object.keys(cfgA.blocks[0]).sort().join(',') === Object.keys(cfgB.blocks[0]).sort().join(','),
    { старое: Object.keys(cfgA.blocks[0]), новое: Object.keys(cfgB.blocks[0]) });
  chk('ключи пункта совпали',
    Object.keys(cfgA.blocks[0].items[0]).sort().join(',') === Object.keys(cfgB.blocks[0].items[0]).sort().join(','),
    { старое: Object.keys(cfgA.blocks[0].items[0]), новое: Object.keys(cfgB.blocks[0].items[0]) });
  chk('критерии звонка совпали',
    JSON.stringify(cfgA.callCriteria) === JSON.stringify(cfgB.callCriteria));

  head('КАБИНЕТЫ');
  await compare('РГО, всё время', 'rgo',
    t => old.getRgoDashboard(t, 'all'), async t => api.call('getRgoDashboard', [t, 'all']));
  await compare('РГО, за месяц', 'rgo',
    t => old.getRgoDashboard(t, 'month'), async t => api.call('getRgoDashboard', [t, 'month']));
  await compare('Дивизион (старший РГО)', 'srgo',
    t => old.getOrgDashboard(t, 'all'), async t => api.call('getOrgDashboard', [t, 'all']));
  await compare('Дивизион (менеджер)', 'mgr',
    t => old.getOrgDashboard(t, 'all'), async t => api.call('getOrgDashboard', [t, 'all']));

  head('ОТЧЁТЫ');
  await compare('Отчёт КК', 'mgr', t => old.getKkReport(t, 'all'), async t => api.call('getKkReport', [t, 'all']));
  await compare('Отчёт КК глазами РГО', 'rgo', t => old.getKkReport(t, 'all'), async t => api.call('getKkReport', [t, 'all']));
  await compare('Недельная сетка', 'mgr', t => old.getWeeklyGrid(t, 0, ''), async t => api.call('getWeeklyGrid', [t, 0, '']));
  await compare('Журнал оценок', 'mgr', t => old.getJournal(t, {}), async t => api.call('getJournal', [t, {}]));
  await compare('Журнал глазами РГО', 'rgo', t => old.getJournal(t, {}), async t => api.call('getJournal', [t, {}]));
  await compare('Критерии по неделям', 'mgr', t => old.getCriteriaReport(t, 'all'), async t => api.call('getCriteriaReport', [t, 'all']));
  await compare('Тематики', 'mgr', t => old.getTopicsReport(t, 'all'), async t => api.call('getTopicsReport', [t, 'all']));
  await compare('Жалобы', 'mgr', t => old.getComplaintsReport(t, 'all'), async t => api.call('getComplaintsReport', [t, 'all']));
  await compare('План прослушки', 'qc', t => old.getListeningPlan(t, '2026-08-10'), async t => api.call('getListeningPlan', [t, '2026-08-10']));

  head('КАБИНЕТ ОПЕРАТОРА');
  await compare('Мои оценки', 'op', t => old.getMyEvaluations(t), async t => api.call('getMyEvaluations', [t]));
  await compare('Бутстрап оператора', 'op', t => old.getOperatorBootstrap(t), async t => api.call('getOperatorBootstrap', [t]));

  head('ПРАВА ДОСТУПА');
  for (const [who, fn, args, label] of [
    ['op', 'getJournal', [{}], 'оператор не видит журнал'],
    ['op', 'getKkReport', ['all'], 'оператор не видит Отчёт КК'],
    ['op', 'getOrgDashboard', ['all'], 'оператор не видит дивизион'],
    ['op', 'getAllUsers', [], 'оператор не видит пользователей'],
    ['qc', 'getOrgDashboard', ['all'], 'СКК не видит дивизион'],
    ['rgo', 'getListeningPlan', ['2026-08-10'], 'РГО не видит план прослушки']
  ]) {
    old._MEM = {};
    const a = old[fn].apply(null, [T[who].old].concat(args));
    const b = await api.call(fn, [T[who].nw].concat(args));
    chk(label, a.success === false && b.success === false, { старое: a.success, новое: b.success });
  }
  const leak = await api.call('getAllUsers', [T.adm.nw]);
  chk('админу пароли не отдаются', leak.success && leak.users.every(u => !u.pin && !u.hash && !u.password_hash),
    leak.users && leak.users[0]);

  head('ЗАПИСЬ: СДАЧА ЗВОНКА И ОЦЕНКА');
  const D = '2026-08-19', TM = '14:25', PH = '77015550011';
  old._MEM = {};
  const rqA = old.createRequest({ pin: T.op.old, hasCall: 'yes', callDate: D, callTime: TM, phone: PH, callType: 'СР' });
  const rqB = await api.call('createRequest', [{ pin: T.op.nw, hasCall: 'yes', callDate: D, callTime: TM, phone: PH, callType: 'СР' }]);
  chk('заявка создана в обеих системах', rqA.success === true && rqB.success === true, { a: rqA, b: rqB });
  chk('статус заявки одинаков', rqA.status === rqB.status, { a: rqA.status, b: rqB.status });

  old._MEM = {};
  const dupA = old.createRequest({ pin: T.op.old, hasCall: 'yes', callDate: D, callTime: TM, phone: PH, callType: 'СР' });
  const dupB = await api.call('createRequest', [{ pin: T.op.nw, hasCall: 'yes', callDate: D, callTime: TM, phone: PH, callType: 'СР' }]);
  chk('дубль заявки отклонён в обеих', dupA.success === false && dupB.success === false, { a: dupA.error, b: dupB.error });

  const ans = {};
  cfgA.blocks.forEach(b => b.items.forEach(i => { if (i.type === 'score') ans[i.id] = 'Положительно'; }));
  ans.B2P1 = 'Сомнительно';
  const meta = { operator: OP[0], group: 'ИНВ-1', callDate: D, callTime: TM, phone: PH, topic: 'Анализы', reqId: rqA.requestId };
  old._MEM = {};
  const evA = old.saveEvaluation({ pin: T.qc.old, meta, answers: ans, comments: { B2P1: 'перебивал клиента' } });
  const evB = await api.call('saveEvaluation', [{ pin: T.qc.nw, meta: Object.assign({}, meta, { reqId: rqB.requestId }), answers: ans, comments: { B2P1: 'перебивал клиента' } }]);
  chk('оценка сохранена в обеих', evA.success === true && evB.success === true, { a: evA.error, b: evB.error });
  chk('балл совпал (98,33)', evA.result.score === evB.result.score && evA.result.score === 98.33,
    { a: evA.result && evA.result.score, b: evB.result && evB.result.score });
  chk('неделя совпала', evA.week === evB.week, { a: evA.week, b: evB.week });
  chk('заявка помечена проверенной в обеих', evA.linkedRequest === true && evB.linkedRequest === true,
    { a: evA.linkedRequest, b: evB.linkedRequest });

  old._MEM = {};
  const dupEvA = old.saveEvaluation({ pin: T.qc.old, meta, answers: ans, comments: {} });
  const dupEvB = await api.call('saveEvaluation', [{ pin: T.qc.nw, meta: Object.assign({}, meta, { reqId: rqB.requestId }), answers: ans, comments: {} }]);
  chk('повторная оценка звонка отклонена в обеих', dupEvA.success === false && dupEvB.success === false,
    { a: dupEvA.error, b: dupEvB.error });

  head('ЦИФРЫ ПОСЛЕ ЗАПИСИ СОШЛИСЬ');
  await compare('РГО после новой оценки', 'rgo',
    t => old.getRgoDashboard(t, 'all'), async t => api.call('getRgoDashboard', [t, 'all']));
  await compare('Дивизион после новой оценки', 'mgr',
    t => old.getOrgDashboard(t, 'all'), async t => api.call('getOrgDashboard', [t, 'all']));
  await compare('Кабинет оператора после оценки', 'op',
    t => old.getOperatorBootstrap(t), async t => api.call('getOperatorBootstrap', [t]));

  head('ВАЛИДАЦИЯ ВВОДА');
  for (const [label, payload] of [
    ['телефон-мусор', { hasCall: 'yes', callDate: D, callTime: '10:00', phone: 'абв', callType: 'СР' }],
    ['дата из будущего', { hasCall: 'yes', callDate: '2099-01-01', callTime: '10:00', phone: '77010001122', callType: 'СР' }],
    ['время не по формату', { hasCall: 'yes', callDate: D, callTime: 'полдень', phone: '77010001133', callType: 'СР' }],
    ['комментарий 60 000 знаков', { hasCall: 'no', comment: 'А'.repeat(60000) }]
  ]) {
    old._MEM = {};
    const a = old.createRequest(Object.assign({ pin: T.op.old }, payload));
    const b = await api.call('createRequest', [Object.assign({ pin: T.op.nw }, payload)]);
    chk(label + ' отклонён в обеих', a.success === false && b.success === false, { a: a.error, b: b.error });
  }
  const badOp = await api.call('saveEvaluation', [{ pin: T.qc.nw, meta: { operator: 'Иваноv Иван', callDate: D }, answers: {} }]);
  chk('оценка на несуществующее ФИО отклонена', badOp.success === false, badOp);

  head('ВЫХОД');
  const outB = await api.call('logoutSession', [T.qc.nw]);
  chk('выход выполнен', outB.success === true, outB);
  const after = await api.call('getListeningPlan', [T.qc.nw, '2026-08-10']);
  chk('погашенный токен больше не работает', after.success === false, after);

  console.log('\n─────────────────────────────');
  console.log(`ПРОВЕРОК: ${checks}   ПРОВАЛЕНО: ${bad.length}`);
  bad.forEach(b => console.log('   ·', b));
  await db.pool.end();
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('СБОЙ:', e); process.exit(1); });
