// Пересоздаёт базу и заново заливает выгрузку.
// Нужен каждому тесту, который что-то пишет: иначе записи прошлого прогона
// копятся и сверка врёт (наступал на это — 33 оценки против 32).
const { execSync } = require('child_process');
const path = require('path');

module.exports = function reset(dump) {
  const root = path.join(__dirname, '..');
  const url = new URL(process.env.DATABASE_URL);
  const dbName = url.pathname.slice(1).split('?')[0];
  const host = url.searchParams.get('host') || url.hostname;
  const port = url.port || 5432;
  const user = url.username || process.env.USER;
  const bin = '/usr/lib/postgresql/16/bin';
  const conn = `-h ${host} -p ${port} -U ${user}`;
  execSync(
    `${bin}/dropdb ${conn} --if-exists ${dbName} && ` +
    `${bin}/createdb ${conn} ${dbName} && ` +
    `${bin}/psql -q ${conn} -d ${dbName} -c 'CREATE EXTENSION citext;' -f ${root}/db/schema.sql`,
    { shell: '/bin/bash', stdio: 'pipe' });
  execSync(`node ${root}/scripts/migrate.js ${dump || path.join(root, 'dump.json')}`, { stdio: 'pipe' });
};
