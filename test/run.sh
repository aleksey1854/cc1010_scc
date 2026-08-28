#!/bin/bash
# Полный прогон. Требует поднятого Postgres и DATABASE_URL.
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?задайте DATABASE_URL}"
total=0; failed=0
for t in parity migration parity-api chain; do
  echo "═══ $t ═══"
  out=$(node test/$t.js 2>&1); code=$?
  echo "$out" | grep -E "✓|✗" | sed 's/^/  /'
  n=$(echo "$out" | grep -c "✓"); f=$(echo "$out" | grep -c "✗")
  total=$((total+n+f)); failed=$((failed+f))
  [ $code -ne 0 ] && [ $f -eq 0 ] && { echo "  ! упал без внятной ошибки"; failed=$((failed+1)); }
  echo ""
done
echo "═══════════════════════════"
echo "ВСЕГО: $total   ПРОВАЛЕНО: $failed"
[ "$failed" -eq 0 ] && echo "ПАРИТЕТ ПОДТВЕРЖДЁН" || exit 1
