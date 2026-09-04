// Сквозная цепочка на Postgres: те же шаги, что t11 на Apps Script
const api = require('../lib/api');
const db = require('../lib/db');
const core = require('../lib/core');
const fs = require('fs');
let bad = [];
const chk = (n, c, d) => { if (c) console.log('  ✓', n); else { console.log('  ✗', n, d !== undefined ? '→ ' + JSON.stringify(d) : ''); bad.push(n); } };
const head = t => console.log('\n━━━ ' + t + ' ━━━');
const R = (fn, ...a) => api.call(fn, a);

(async () => {
  require('./reset')();     // чистая база: иначе записи прошлого прогона копятся
  const creds = JSON.parse(fs.readFileSync(require('path').join(__dirname,'..','seed-creds.json'),'utf8'));
  const OP = creds.find(x => x[2] === 'operator' && x[1] === 'ИНВ-1');
  const QC = creds.find(x => x[2] === 'qc');
  const RGO = creds.find(x => x[2] === 'rgo' && x[1] === 'ИНВ-1');
  const SRGO = creds.find(x => x[2] === 'srgo');
  const MGR = creds.find(x => x[2] === 'manager');

  head('ВХОД');
  const lo = await R('login', OP[3], OP[4]);
  chk('оператор вошёл', lo.success === true, lo.error);
  chk('выдан токен', /^T-/.test(lo.token || ''));
  chk('роль и группа верные', lo.role === 'operator' && lo.group === 'ИНВ-1', { r: lo.role, g: lo.group });
  const opT = lo.token;
  const qcT = (await R('login', QC[3], QC[4])).token;
  const rgoT = (await R('login', RGO[3], RGO[4])).token;
  const srgoT = (await R('login', SRGO[3], SRGO[4])).token;
  const mgrT = (await R('login', MGR[3], MGR[4])).token;
  chk('неверный пароль отклонён', (await R('login', OP[3], 'nepravilno')).success === false);
  chk('пароль как токен не работает', (await R('getOperatorStats', OP[4])).success === false);

  head('ШАГ 1. ОПЕРАТОР СДАЁТ ЗВОНОК');
  const DATE = core.isoDate(new Date());
  const req = await R('createRequest', { pin: opT, hasCall: 'yes', callDate: DATE, callTime: '11:20', phone: '77011234567', callType: 'СР' });
  chk('заявка создана', req.success === true, req.error);
  chk('статус «Новая»', req.status === 'Новая', req.status);
  const REQ_ID = req.requestId;
  const dup = await R('createRequest', { pin: opT, hasCall: 'yes', callDate: DATE, callTime: '11:20', phone: '77011234567', callType: 'СР' });
  chk('дубль отклонён базой', dup.success === false, dup);
  const st1 = await R('getOperatorStats', opT);
  chk('счётчик новых = 1', st1.stats.new === 1, st1.stats);

  head('ШАГ 2. СКК ВИДИТ ЗАЯВКУ');
  const boot = await R('getQcBootstrap', qcT);
  chk('чек-лист загружен: 27 пунктов, максимум 90',
    boot.cfg.blocks.reduce((s, b) => s + b.items.length, 0) === 27 && boot.cfg.maxTotal === 90,
    { items: boot.cfg.blocks.reduce((s, b) => s + b.items.length, 0), max: boot.cfg.maxTotal });
  chk('варианты по-русски, как ждёт интерфейс',
    boot.cfg.blocks[0].items[0].options.some(o => o.value === 'Положительно'),
    boot.cfg.blocks[0].items[0].options);
  const nOps = creds.filter(x => x[2] === 'operator').length;
  chk('список операторов: ' + nOps, boot.operators.length === nOps, boot.operators.length);
  const rq = await R('getRequestsByOperator', qcT, OP[0]);
  chk('заявка видна СКК', rq.requests.some(r => r.id === REQ_ID), rq.requests.slice(0, 2));
  chk('в заявке те дата и телефон',
    rq.requests[0].callDate === DATE && rq.requests[0].phone === '77011234567', rq.requests[0]);

  head('ШАГ 3. ОЦЕНКА');
  const ans = {};
  boot.cfg.blocks.forEach(b => b.items.forEach(i => { if (i.type === 'score') ans[i.id] = 'Положительно'; }));
  ans.B2P1 = 'Сомнительно';
  // Описание звонка теперь обязательно целиком, поэтому meta заполнена полностью
  const META = {
    operator: OP[0], group: 'ИНВ-1', callDate: DATE, callTime: '11:20',
    phone: '79161234567', criterion: 'Длит: средний (3-5 мин)',
    topic: 'Анализы', sub: 'Стоимость', city: 'Москва', reqId: REQ_ID
  };
  const ev = await R('saveEvaluation', { pin: qcT, meta: META, answers: ans, comments: { B2P1: 'перебивал клиента' } });
  chk('оценка сохранена', ev.success === true, ev.error);
  chk('итог 98,33 — тот же, что в Apps Script', ev.result.score === 98.33, ev.result && ev.result.score);
  chk('некритичных 1, критичных 0', ev.result.minor === 1 && ev.result.critical === 0, ev.result);
  chk('заявка привязана', ev.linkedRequest === true);

  // Тот же звонок целиком и с полным чек-листом: отказать должна база,
  // а не проверка заполненности — иначе тест ловил бы не то, что заявлено
  const again = await R('saveEvaluation', { pin: qcT, meta: { ...META, reqId: '' }, answers: ans, comments: {} });
  chk('повторная оценка того же звонка запрещена', again.success === false, again);
  chk('  и отказывает именно из-за дубля', /оцен/i.test(again.error || ''), again.error);

  head('ШАГ 3а. ЧЕГО НЕ ПРОПУСКАЕТ');
  const noAnswers = await R('saveEvaluation', { pin: qcT, meta: { ...META, reqId: '', callTime: '12:00' }, answers: {} });
  chk('пустой чек-лист не сохраняется', noAnswers.success === false, noAnswers);
  chk('  и говорит, сколько осталось', /осталось пунктов/.test(noAnswers.error || ''), noAnswers.error);

  const half = { ...ans }; delete half[Object.keys(half)[0]];
  chk('недозаполненный чек-лист не сохраняется',
    (await R('saveEvaluation', { pin: qcT, meta: { ...META, reqId: '', callTime: '12:05' }, answers: half })).success === false);

  for (const [поле, msg] of [['callTime', 'время'], ['phone', 'телефон'], ['criterion', 'длительность'],
                             ['topic', 'тематику'], ['city', 'город'], ['sub', 'подтематику']]) {
    const meta = { ...META, reqId: '', callTime: '12:10' };
    meta[поле] = '';
    const r = await R('saveEvaluation', { pin: qcT, meta, answers: ans });
    chk('без «' + поле + '» не сохраняется', r.success === false && new RegExp(msg, 'i').test(r.error || ''), r.error);
  }

  chk('оператор не может сохранять оценки',
    (await R('saveEvaluation', { pin: opT, meta: META, answers: ans })).success === false);
  chk('оценка на несуществующее ФИО отклонена',
    (await R('saveEvaluation', { pin: qcT, meta: { ...META, operator: 'Никого Нет' }, answers: ans })).success === false);
  chk('дата из будущего отклонена',
    (await R('saveEvaluation', { pin: qcT, meta: { ...META, callDate: '2099-01-01' }, answers: ans })).success === false);

  head('ШАГ 3б. ЖАЛОБА, ЗАМЕЧАНИЯ И ПРАВКА ПО АПЕЛЛЯЦИИ');
  // на другого оператора, чтобы не мешать проверке его кабинета ниже
  const OP2 = creds.find(x => x[2] === 'operator' && x[1] === 'ИНВ-1' && x[0] !== OP[0]);
  const cAns = { ...ans, B8P3: 'Обнаружено' };
  const cMeta = { ...META, operator: OP2[0], reqId: '', callTime: '13:00' };
  const noSrc = await R('saveEvaluation', { pin: qcT, meta: cMeta, answers: cAns });
  chk('признак жалобы без источника не сохраняется', noSrc.success === false, noSrc);
  chk('  и говорит, чего не хватает', /от кого жалоба/i.test(noSrc.error || ''), noSrc.error);
  chk('чужой источник отклонён',
    (await R('saveEvaluation', { pin: qcT, meta: { ...cMeta, complaintSource: 'Кто-то' }, answers: cAns })).success === false);

  // замечание к выполненному пункту: раньше такая строка молча терялась
  const cEv = await R('saveEvaluation', {
    pin: qcT, meta: { ...cMeta, complaintSource: 'Клиент' }, answers: cAns,
    comments: { B2P1: 'перебивал', B1P1: 'поздоровался, но тихо' }
  });
  chk('жалоба с источником сохранена', cEv.success === true, cEv.error);

  const card = await R('getEvaluationCard', qcT, cEv.id);
  chk('карточка оценки открывается', card.success === true, card.error);
  chk('  источник жалобы вернулся', card.meta.complaintSource === 'Клиент', card.meta);
  chk('  замечание к «Положительно» сохранилось',
    card.comments.B1P1 === 'поздоровался, но тихо', card.comments);
  chk('  выполненный пункт вернулся как «Положительно»',
    card.answers.B3P1 === 'Положительно', card.answers.B3P1);
  chk('оператору карточка закрыта', (await R('getEvaluationCard', opT, cEv.id)).success === false);

  // апелляция: снимаем ошибку и убираем комментарий
  const fixed = { ...cAns, B2P1: 'Положительно' };
  const upd = await R('updateEvaluation', {
    pin: qcT, meta: { ...cMeta, complaintSource: 'Клиент', evId: cEv.id },
    answers: fixed, comments: {}
  });
  chk('СКК правит оценку по апелляции', upd.success === true, upd.error);
  chk('  балл пересчитан вверх', upd.result.score > cEv.result.score, [cEv.result.score, upd.result.score]);
  const after = await R('getEvaluationCard', qcT, cEv.id);
  chk('  комментарий убран', !after.comments.B2P1, after.comments);
  chk('  замечание тоже снято', !after.comments.B1P1, after.comments);
  chk('  ошибок не осталось', after.answers.B2P1 === 'Положительно', after.answers.B2P1);
  chk('оператор править не может',
    (await R('updateEvaluation', { pin: opT, meta: { ...cMeta, evId: cEv.id }, answers: fixed })).success === false);
  chk('несуществующая оценка не правится',
    (await R('updateEvaluation', { pin: qcT, meta: { ...cMeta, evId: 'EV-НЕТ' }, answers: fixed })).success === false);

  const cmp = await R('getComplaintsReport', mgrT, 'all');
  chk('жалоба попала в отчёт', cmp.success === true && cmp.summary.total >= 1, cmp.summary);
  chk('  и учтена как «от клиента»', cmp.summary.confClient + cmp.summary.unconfClient >= 1, cmp.summary);

  head('ШАГ 3в. СОСТАВ ВЕДУТ СРГО, РУКОВОДИТЕЛЬ И АДМИН');
  // токены СРГО и руководителя уже получены на шаге входа
  chk('СРГО видит состав', (await R('getAllUsers', srgoT)).success === true);
  chk('руководитель видит состав', (await R('getAllUsers', mgrT)).success === true);
  chk('СКК к составу не пускают', (await R('getAllUsers', qcT)).success === false);
  chk('оператора к составу не пускают', (await R('getAllUsers', opT)).success === false);

  const NEW_NAME = 'Проверка Составом';
  const added = await R('addUser', srgoT, NEW_NAME, 'ИНВ-3', 'operator', '', 'Sostav77x');
  chk('СРГО заводит сотрудника', added.success === true, added.error);
  chk('  логин собрался из ФИО', /^proverka/.test(added.login || ''), added.login);
  chk('  и он входит', (await R('login', added.login, 'Sostav77x')).success === true);
  chk('СРГО меняет роль и группу',
    (await R('updateUser', srgoT, NEW_NAME, NEW_NAME, 'СКК', 'qc')).success === true);
  chk('СРГО сбрасывает пароль',
    (await R('resetPassword', srgoT, NEW_NAME, 'Drug0jPar')).success === true);
  chk('  старый пароль погас', (await R('login', added.login, 'Sostav77x')).success === false);
  chk('  новый работает', (await R('login', added.login, 'Drug0jPar')).role === 'qc');
  chk('СКК завести сотрудника не может',
    (await R('addUser', qcT, 'Никто Никакой', '', 'operator', '', 'Parol123x')).success === false);
  chk('СРГО увольняет', (await R('deleteUser', srgoT, NEW_NAME)).success === true);
  chk('  уволенный не входит', (await R('login', added.login, 'Drug0jPar')).success === false);
  chk('себя удалить нельзя', (await R('deleteUser', srgoT, SRGO[0])).success === false);

  const audit = await R('auditAccounts', srgoT);
  chk('состояние учёток считается', audit.success === true && typeof audit.total === 'number', audit);

  head('ШАГ 3б. ИСТОРИЯ ЗАЯВКИ');
  const hist = await R('getRequestHistory', qcT, REQ_ID);
  chk('история отдана', hist.success === true, hist.error);
  const events = (hist.events || []).map(e => e.event);
  chk('в ней есть создание и оценка',
    events.includes('Заявка создана') && events.includes('Звонок оценён'), events);
  chk('у каждого события есть автор и время',
    (hist.events || []).every(e => e.who && e.at), hist.events && hist.events[0]);
  chk('чужую заявку оператору не отдаёт',
    (await R('getRequestHistory', (await R('login', creds.find(x => x[2] === 'operator' && x[0] !== OP[0])[3],
      creds.find(x => x[2] === 'operator' && x[0] !== OP[0])[4])).token, REQ_ID)).success === false);

  head('ШАГ 4. ОПЕРАТОР ВИДИТ РЕЗУЛЬТАТ');
  const ob = await R('getOperatorBootstrap', opT);
  chk('оценка видна', ob.evals.evaluations.length === 1, ob.evals.evaluations.length);
  chk('балл 98,33', ob.evals.evaluations[0].score === 98.33, ob.evals.evaluations[0].score);
  chk('видна ошибка с комментарием СКК',
    ob.evals.evaluations[0].failed.length === 1 && ob.evals.evaluations[0].failed[0].comment === 'перебивал клиента',
    ob.evals.evaluations[0].failed);
  chk('текст пункта подставлен', /\S/.test(ob.evals.evaluations[0].failed[0].text), ob.evals.evaluations[0].failed[0]);
  chk('заявка стала «Проверена»', ob.requests.find(r => r.id === REQ_ID).status === 'Проверена',
    ob.requests.find(r => r.id === REQ_ID));
  chk('в заявке проставлен балл', Number(ob.requests.find(r => r.id === REQ_ID).rating) === 98.33);
  chk('счётчик новых стал 0, проверено 1', ob.stats.new === 0 && ob.stats.checked === 1, ob.stats);

  head('ШАГ 5. КАБИНЕТ РГО');
  const rgo = await R('getRgoDashboard', rgoT, 'all');
  chk('кабинет открылся', rgo.success === true, rgo.error);
  const nTeam = creds.filter(x => x[2] === 'operator' && x[1] === RGO[1]).length;
  chk('операторов в группе ' + nTeam, rgo.summary.operatorsTotal === nTeam, rgo.summary.operatorsTotal);
  chk('видит только свою группу', rgo.scope === 'ИНВ-1', rgo.scope);
  chk('операторы без проверок → avgScore null',
    rgo.operators.filter(o => o.checkedCount === 0).every(o => o.avgScore === null));
  const mine = rgo.operators.find(o => o.fullName === OP[0]);
  chk('у нашего оператора виден балл', mine && mine.avgScore !== null, mine);

  head('ШАГ 6. СРГО И МЕНЕДЖЕР');
  const org = await R('getOrgDashboard', srgoT, 'all');
  chk('дивизион открылся', org.success === true, org.error);
  chk('операторов всего ' + nOps, org.summary.operatorsTotal === nOps, org.summary.operatorsTotal);
  chk('в разрезе групп есть ИНВ-1', org.byGroup.some(g => g.group === 'ИНВ-1'));
  const mgr = await R('getOrgDashboard', mgrT, 'all');
  chk('менеджер видит те же цифры',
    mgr.summary.callsChecked === org.summary.callsChecked && mgr.summary.avgScore === org.summary.avgScore,
    { m: mgr.summary, s: org.summary });
  chk('в работе СКК виден контролёр', org.byQc.some(q => q.qc === QC[0]), org.byQc.slice(0, 2));

  head('ШАГ 7. СОГЛАСОВАННОСТЬ ЦИФР');
  const all = await db.q(`SELECT score FROM evaluations`);
  const trueAvg = core.round2(all.reduce((s, r) => s + Number(r.score), 0) / all.length);
  chk('дивизион: средний = среднему по всем звонкам', org.summary.avgScore === trueAvg,
    { дашборд: org.summary.avgScore, поЗвонкам: trueAvg });
  const g1 = org.byGroup.find(g => g.group === 'ИНВ-1');
  const g1db = await db.one(`SELECT round(avg(score),2)::float a, count(*)::int n FROM evaluations WHERE team='ИНВ-1'`);
  chk('группа ИНВ-1 сходится с базой', g1.avgScore === g1db.a && g1.callsChecked === g1db.n, { отчёт: g1, база: g1db });
  chk('РГО и дивизион дают одну цифру по ИНВ-1', rgo.summary.avgScore === g1db.a,
    { рго: rgo.summary.avgScore, база: g1db.a });

  head('ШАГ 8. ПЛАН ПРОСЛУШКИ');
  const imp = await R('importAcceptedCalls', qcT, DATE, OP[0] + ';200\n' + creds.find(x => x[2] === 'operator' && x[0] !== OP[0])[0] + ';24');
  chk('статистика загружена', imp.success && imp.imported === 2, imp);
  const plan = await R('getListeningPlan', qcT, DATE);
  const pr = plan.rows.find(r => r.operator === OP[0]);
  chk('200 × 2% = 4', pr.plan === 4, pr);
  chk('прослушано 1, осталось 3', pr.done === 1 && pr.left === 3, pr);
  chk('звонок с заявкой засчитан оператору', pr.fromOperator === 1 && pr.bySkk === 0, pr);
  chk('24 × 2% = 0', plan.rows.find(r => r.plan === 0) !== undefined);

  head('ШАГ 9. ОТЧЁТЫ');
  for (const [n, fn, args] of [
    ['журнал', 'getJournal', [mgrT, {}]],
    ['Отчёт КК', 'getKkReport', [mgrT, 'all']],
    ['недели', 'getWeeklyGrid', [mgrT, 0, '']],
    ['критерии', 'getCriteriaReport', [mgrT, 'all']],
    ['тематики', 'getTopicsReport', [mgrT, 'all']],
    ['жалобы', 'getComplaintsReport', [mgrT, 'all']],
    ['экспорт CSV', 'exportReport', [mgrT, 'journal', {}]]
  ]) {
    const r = await api.call(fn, args);
    chk(n, r.success === true, r.error);
  }
  const rgoRep = await R('getTopicsReport', rgoT, 'all');
  chk('РГО получил доступ к тематикам (было «Нет доступа»)', rgoRep.success === true, rgoRep.error);
  chk('оператору отчёты закрыты', (await R('getKkReport', opT, 'all')).success === false);

  // СКК ведёт качество по всему КЦ — отчёты ему нужны наравне со старшим
  for (const [n, fn, args] of [
    ['СКК: оценки по неделям', 'getWeeklyGrid', [qcT, 0, '']],
    ['СКК: жалобы', 'getComplaintsReport', [qcT, 'all']],
    ['СКК: тематики', 'getTopicsReport', [qcT, 'all']],
    ['СКК: критерии', 'getCriteriaReport', [qcT, 'all']]
  ]) {
    const r = await api.call(fn, args);
    chk(n + ' (было «Нет доступа»)', r.success === true, r.error);
  }

  // выгрузку сдают за конкретный отрезок, а не за «этот месяц»
  const jAll = await R('getJournal', qcT, { period: 'all' });
  const one = await R('getJournal', qcT, { from: DATE, to: DATE });
  chk('журнал за диапазон дат', one.success === true && one.rows.length > 0, one.error);
  chk('  диапазон отсекает лишнее', one.rows.length <= jAll.rows.length, [one.rows.length, jAll.rows.length]);
  chk('  все строки внутри диапазона',
    one.rows.every(r => r.callDate === core.fmtDate(DATE)), one.rows.slice(0, 2));
  // ищем по части ФИО — под одну фамилию может попасть несколько человек
  const part = OP[0].split(' ')[0];
  const byOp = await R('getJournal', qcT, { period: 'all', operator: part });
  chk('фильтр по оператору работает (был мёртвым)',
    byOp.success === true && byOp.rows.length > 0 && byOp.rows.every(r => r.operator.includes(part)),
    byOp.rows && byOp.rows.map(r => r.operator));
  chk('  несуществующее ФИО даёт пусто',
    (await R('getJournal', qcT, { period: 'all', operator: 'Такого Нет' })).rows.length === 0);
  // «только ПЖ/НС» слал onlyKo, а сервер читал onlyFlags — фильтр был мёртвым
  const pj = await R('getJournal', qcT, { period: 'all', onlyComplaint: true });
  chk('фильтр «только ПЖ» работает',
    pj.success === true && pj.rows.every(r => r.complaint), pj.rows && pj.rows.length);
  const ns = await R('getJournal', qcT, { period: 'all', onlyViolation: true });
  chk('фильтр «только НС» работает',
    ns.success === true && ns.rows.every(r => r.violation), ns.rows && ns.rows.length);
  chk('  ПЖ и НС — разные выборки', pj.rows.length !== jAll.rows.length || ns.rows.length !== jAll.rows.length);

  const cmpRange = await R('getComplaintsReport', qcT, 'all', '2000-01-01', '2000-01-02');
  chk('жалобы за пустой диапазон — ноль строк',
    cmpRange.success === true && cmpRange.rows.length === 0, cmpRange);

  head('ШАГ 10. СЕССИИ');
  await R('logoutSession', opT);
  chk('после выхода токен не работает', (await R('getOperatorStats', opT)).success === false);
  const cp = await R('changePassword', qcT, QC[4], 'NovyyParol9');
  chk('смена пароля прошла', cp.success === true, cp.error);
  chk('старый токен погашен', (await R('getQcBootstrap', qcT)).success === false);
  chk('старый пароль больше не подходит', (await R('login', QC[3], QC[4])).success === false);
  chk('новый пароль работает', (await R('login', QC[3], 'NovyyParol9')).success === true);

  console.log(`\nПРОВАЛЕНО: ${bad.length}`);
  bad.forEach(b => console.log('   ·', b));
  await db.pool.end();
  process.exit(bad.length ? 1 : 0);
})();
