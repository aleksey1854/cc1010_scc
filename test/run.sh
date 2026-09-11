#!/bin/bash
# Полный прогон. Требует поднятого Postgres и DATABASE_URL.
cd "$(dirname "$0")/.."
# Тесты пересоздают схему и стирают данные — по умолчанию берут .env,
# но боевую базу так трогать нельзя: ENV_FILE=.env.test bash test/run.sh
ENV_FILE="${ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] || : "${DATABASE_URL:?задайте DATABASE_URL или положите $ENV_FILE}"
total=0; failed=0; skipped=""
for t in parity migration parity-api chain; do
  echo "═══ $t ═══"
  out=$(node --env-file-if-exists="$ENV_FILE" test/$t.js 2>&1); code=$?
  echo "$out" | grep -E "✓|✗" | sed 's/^/  /'
  n=$(echo "$out" | grep -c "✓"); f=$(echo "$out" | grep -c "✗")
  total=$((total+n+f)); failed=$((failed+f))
  # Пропущенный набор молчал, и в итоге выходило «238 из 238» — цифра
  # верная, но она скрывала, что два набора вообще не выполнялись.
  if echo "$out" | grep -q "ПРОПУЩЕН"; then
    echo "  ⊘ ПРОПУЩЕН: $(echo "$out" | grep "ПРОПУЩЕН" | head -1 | sed 's/ПРОПУЩЕН: //')"
    skipped="$skipped $t"
  elif [ $n -eq 0 ] && [ $f -eq 0 ] && [ $code -eq 0 ]; then
    echo "  ! набор отработал, но не сделал ни одной проверки"
    failed=$((failed+1))
  fi
  [ $code -ne 0 ] && [ $f -eq 0 ] && { echo "  ! упал без внятной ошибки (код $code)"; failed=$((failed+1)); }
  echo ""
done
echo "═══════════════════════════"
echo "ВСЕГО: $total   ПРОВАЛЕНО: $failed"
[ -n "$skipped" ] && echo "ПРОПУЩЕНО НАБОРОВ:$skipped — эти проверки не выполнялись"
# «Паритет подтверждён» вправе говорить только прогон, где сверка со
# старым проектом действительно была.
if [ "$failed" -ne 0 ]; then exit 1; fi
if [ -n "$skipped" ]; then
  echo "ПРОВЕРКИ ПРОШЛИ (сверка со старым проектом не выполнялась)"
else
  echo "ПАРИТЕТ ПОДТВЕРЖДЁН"
fi
