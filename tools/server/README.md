# Российский сервер a1010.ru

С 14.10.2026 сайт **a1010.ru** отдаёт виртуальная машина в Cloud.ru (`a1010-proxy`,
45.151.31.60, Ubuntu 24.04), а не Vercel. Российские провайдеры то и дело режут
адреса Vercel; а когда трафик шёл через наш сервер пересылкой, Vercel стал
пропускать его только после «Security Checkpoint», и запросы данных получали 403.

База та же — Neon. Vercel продолжает выкатывать main и остаётся запасным
(`cc1010-scc.vercel.app`).

| Что | Где |
|---|---|
| Сайт (Node, `scripts/dev-server.js`) | служба `a1010-app` → `a1010-app.service` |
| nginx: TLS, сжатие, 80 → 443 | `/etc/nginx/sites-available/a1010` ← `nginx-a1010.conf` |
| Сертификат Let's Encrypt | `/etc/letsencrypt/live/a1010.ru`, продление — `certbot.timer` |
| Выкатка main раз в минуту | `a1010-deploy.timer` → `/opt/a1010/deploy.sh` ← `deploy.sh` |
| Настройки (DATABASE_URL) | `/opt/a1010/.env`, права 600 |
| Журналы | `journalctl -u a1010-app`, `journalctl -t a1010-deploy`, `/var/log/nginx/a1010-access.log` |

Вход: `ssh -i ~/.ssh/cloudru_ed25519 a1010@45.151.31.60` (только ключ).

**Откат на Vercel**, если сервер подвёл: вернуть в DNS a1010.ru две A-записи
76.76.21.21 и 216.198.79.1 (делает IT). Схема «пересылка на Vercel» лежит в
`/opt/a1010/rollback/` — но через неё Vercel показывает свою проверку.
