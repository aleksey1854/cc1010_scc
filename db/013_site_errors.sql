-- ============================================================
-- 013: журнал ошибок сайта
--
-- Сбои, которые видит человек, раньше не видел никто, кроме него:
-- ошибки страницы терялись в консоли браузера, сбои сервера — в логах
-- Vercel. Теперь каждый системный сбой пишется сюда сам — и со стороны
-- браузера (нет связи, сервер не ответил, ошибка скрипта), и со стороны
-- сервера (исключение в обработчике). Ошибки ввода («выберите город»)
-- сюда не пишутся: это не сбой.
--
-- staff_id может быть пустым: сбой сервера до разбора токена.
-- Старше 90 дней записи удаляются сами при следующей записи.
-- ============================================================
CREATE TABLE IF NOT EXISTS site_errors (
  id        bigserial   PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  source    text        NOT NULL,            -- client | server
  code      text        NOT NULL,            -- NET_FAIL, SRV_500, JS_ERROR…
  message   text        NOT NULL DEFAULT '', -- что увидел человек
  detail    text        NOT NULL DEFAULT '', -- для разбора: вызов, статус, стек
  place     text        NOT NULL DEFAULT '', -- раздел сайта
  staff_id  bigint      REFERENCES staff(id) ON DELETE SET NULL,
  who       text        NOT NULL DEFAULT '', -- ФИО строкой: переживёт удаление
  role      text        NOT NULL DEFAULT '',
  ua        text        NOT NULL DEFAULT ''  -- браузер
);
CREATE INDEX IF NOT EXISTS site_errors_at_idx ON site_errors (at DESC);
