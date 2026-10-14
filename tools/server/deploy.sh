#!/bin/bash
# ============================================================
# /opt/a1010/deploy.sh — выкатка a1010.ru на российском сервере.
# Служба a1010-deploy (таймер, раз в минуту): если в main на GitHub
# появилось новое — подтягивает, перезапускает сайт и проверяет связь
# с базой. Не поднялся за 20 с — возвращает прежнюю версию.
# В main попадает только то, что прошло test/run.sh, — тот же порядок,
# что и для Vercel.
# ============================================================
set -euo pipefail
APP=/opt/a1010/app
as_app() { sudo -u a1010 -H "$@"; }
cd "$APP"
as_app git fetch -q origin main
NEW=$(as_app git rev-parse origin/main)
OLD=$(as_app git rev-parse HEAD)
[ "$NEW" = "$OLD" ] && exit 0

deps_changed() { as_app git diff --quiet "$1" "$2" -- package-lock.json || echo yes; }
switch_to() {
  local from=$1 to=$2
  as_app git reset -q --hard "$to"
  if [ -n "$(deps_changed "$from" "$to")" ]; then
    as_app npm ci --omit=dev --no-audit --no-fund --loglevel=error
  fi
  systemctl restart a1010-app
}
healthy() {
  for _ in $(seq 1 20); do
    curl -fs -X POST -H 'content-type: application/json' -d '{"args":[]}' \
      http://127.0.0.1:3000/api/health | grep -q '"ok":true' && return 0
    sleep 1
  done
  return 1
}

switch_to "$OLD" "$NEW"
if healthy; then
  logger -t a1010-deploy "выкачено ${NEW:0:7} (было ${OLD:0:7})"
  exit 0
fi
switch_to "$NEW" "$OLD"
logger -t a1010-deploy "ОТКАТ: ${NEW:0:7} не поднялся, вернул ${OLD:0:7}"
exit 1
