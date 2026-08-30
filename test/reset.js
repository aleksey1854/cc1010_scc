// Пересоздаёт базу и заново заливает выгрузку.
// Нужен каждому тесту, который что-то пишет: иначе записи прошлого прогона
// копятся и сверка врёт (наступал на это — 33 оценки против 32).
// Схему пересоздаём изнутри (scripts/db-reset.js): psql и dropdb есть не на
// каждой машине, а на Neon базу и вовсе не пересоздать.
const { execSync } = require('child_process');
const path = require('path');

module.exports = function reset(dump) {
  const root = path.join(__dirname, '..');
  const run = cmd => execSync(cmd, { stdio: 'pipe', cwd: root });
  run(`node "${path.join(root, 'scripts', 'db-reset.js')}"`);
  run(`node "${path.join(root, 'scripts', 'migrate.js')}" "${dump || path.join(root, 'dump.json')}"`);
};
