-- ============================================================
-- 016: картинки к апелляции
--
-- Просьба ССКК: к апелляции прикладывают скриншот (ошибка в карточке,
-- переписка, запись в системе). Ссылкой не получалось — картинки кидали
-- в личку. Теперь картинку вставляют прямо в апелляцию.
--
-- Отдельная таблица, а не столбец в appeals: список апелляций грузится
-- целиком, и тянуть за ним мегабайты незачем — картинку отдаём по одной,
-- когда её открыли. Сжимает браузер (до ~0,5 МБ), сервер проверяет
-- размер и что это действительно картинка.
-- ============================================================
CREATE TABLE IF NOT EXISTS appeal_images (
  id          bigserial   PRIMARY KEY,
  appeal_id   bigint      NOT NULL REFERENCES appeals(id) ON DELETE CASCADE,
  mime        text        NOT NULL,
  data        bytea       NOT NULL,
  width       int         NOT NULL DEFAULT 0,
  height      int         NOT NULL DEFAULT 0,
  sort_order  int         NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appeal_images_appeal_idx ON appeal_images (appeal_id, sort_order);
