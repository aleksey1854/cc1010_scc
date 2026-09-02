// ============================================================
// scripts/set-staff.js — заменить контролирующий состав настоящим.
//
// На вход — JSON [[ФИО, группа, роль], ...], собранный из выгрузки
// «Сотрудники» в Битриксе.
//
// Существующие учётки не удаляются, а переименовываются: у оценок
// стоит ссылка на контролёра, и удаление порвало бы авторство.
// Кого в списке нет — гасим, кого не хватает — заводим.
// Операторов не трогаем: они приехали из выгрузки звонков.
//
//   DATABASE_URL=... node scripts/set-staff.js staff.json
// ============================================================
const fs = require('fs');
const core = require('../lib/core');
const db = require('../lib/db');

const SRC = process.argv[2];
if (!SRC) { console.error('укажите файл состава'); process.exit(1); }

const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
let seed = 20260903;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pass = () => Array.from({ length: 10 }, () => ALPHABET[Math.floor(rnd() * ALPHABET.length)]).join('');

async function main() {
  const want = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const byRole = {};
  want.forEach(([name, team, role]) => (byRole[role] = byRole[role] || []).push({ name, team }));

  const creds = [];
  const stat = { переименовано: 0, заведено: 0, погашено: 0 };

  await db.tx(async (t) => {
    const taken = {};
    (await t.q(`SELECT login FROM staff WHERE active AND login IS NOT NULL`))
      .forEach(r => { taken[r.login] = true; });

    for (const role of Object.keys(byRole)) {
      const have = await t.q(
        `SELECT id, full_name, login FROM staff WHERE active AND role = $1 ORDER BY id`, [role]);
      const need = byRole[role];

      for (let i = 0; i < Math.max(have.length, need.length); i++) {
        const row = have[i], person = need[i];

        if (row && person) {
          delete taken[row.login];
          const login = core.suggestLogin(person.name, taken);
          taken[login] = true;
          const pw = pass();
          await t.q(`UPDATE staff SET full_name=$2, team=$3, login=$4, password_hash=$5, updated_at=now()
                      WHERE id=$1`, [row.id, person.name, person.team, login, core.hashPassword(pw)]);
          // имя контролёра в заявках хранится строкой — обновляем и его
          await t.q(`UPDATE call_requests SET checked_by=$2 WHERE checked_by=$1`, [row.full_name, person.name]);
          await t.q(`UPDATE request_events SET actor_name=$2 WHERE actor_name=$1`, [row.full_name, person.name]);
          creds.push([person.name, person.team, role, login, pw]);
          stat.переименовано++;
        } else if (person) {
          const login = core.suggestLogin(person.name, taken);
          taken[login] = true;
          const pw = pass();
          await t.q(`INSERT INTO staff (full_name, team, role, login, password_hash)
                     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [person.name, person.team, role, login, core.hashPassword(pw)]);
          creds.push([person.name, person.team, role, login, pw]);
          stat.заведено++;
        } else {
          // лишняя учётка: гасим, оценки за ней остаются
          await t.q(`UPDATE staff SET active=false, login=NULL, updated_at=now() WHERE id=$1`, [row.id]);
          await t.q(`DELETE FROM sessions WHERE staff_id=$1`, [row.id]);
          stat.погашено++;
        }
      }
    }
  });

  fs.writeFileSync('staff-creds.json', JSON.stringify(creds, null, 1));
  console.log('=== СОСТАВ ОБНОВЛЁН ===');
  for (const [k, v] of Object.entries(stat)) console.log('  ' + k.padEnd(15) + v);
  const rows = await db.q(`SELECT role::text, count(*)::int n FROM staff WHERE active GROUP BY 1 ORDER BY 1`);
  console.log('  ' + rows.map(r => r.role + ': ' + r.n).join(', '));
  console.log('  учётки в staff-creds.json');
  await db.pool.end();
}

main().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
