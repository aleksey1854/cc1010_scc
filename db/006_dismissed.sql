-- ============================================================
-- 006: дата увольнения
--
-- Уволенного не вычёркиваем сразу: на его звонок ещё три месяца может
-- прийти жалоба, и её надо разобрать. Войти он не может — логин
-- освобождается при увольнении, — но в списках остаётся.
-- ============================================================
ALTER TABLE staff ADD COLUMN IF NOT EXISTS dismissed_at date;

-- У тех, кого уволили раньше, даты нет. Настоящую берём из журнала
-- действий, если увольнение там записано; остальных считаем выбывшими
-- давно. Без этого недавно уволенный сразу выпадал бы из списков, хотя
-- по правилу должен быть виден ещё три месяца.
UPDATE staff s SET dismissed_at = f.at::date
  FROM (SELECT details, max(at) AS at FROM audit_log
         WHERE event IN ('Удалён пользователь', 'Уволен сотрудник')
         GROUP BY details) f
 WHERE NOT s.active AND s.dismissed_at IS NULL AND f.details = s.full_name;

UPDATE staff SET dismissed_at = '2000-01-01'
 WHERE NOT active AND dismissed_at IS NULL;
