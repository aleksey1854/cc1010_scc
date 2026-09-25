@echo off
rem CallAudit1010: access fix WITHOUT administrator rights.
rem Creates a desktop shortcut that opens the site in Chrome / Yandex / Edge
rem with --host-resolver-rules pointing cc1010-scc.vercel.app at 76.76.21.21.
rem No system files are changed. Double-click to run.
rem The script body below the marker is PowerShell; this header stays ASCII.
setlocal
set "CA_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:CA_SELF,[Text.Encoding]::UTF8); $i=$t.IndexOf([char]10+'#PS-START'); iex $t.Substring($i)"
exit /b %errorlevel%

#PS-START
# ------------------------------------------------------------------
# Вариант для компьютеров без прав администратора: hosts там не
# изменить. Вместо этого браузер запускается с ключом, который велит
# ему самому ходить на доступный адрес Vercel 76.76.21.21. Ключ
# действует, только если браузер запущен с ним, поэтому делаем ярлык
# на рабочем столе, и сайт открывают через него. Профиль у ярлыка
# свой: иначе при уже открытом браузере ключ молча не сработал бы.
# ------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$Name = 'cc1010-scc.vercel.app'
$Ip   = '76.76.21.21'
$Url  = "https://$Name/"
# CA_DESKTOP / CA_NOLAUNCH — только для проверки: ярлык в другую папку, браузер не открывать
$Test = [bool]$env:CA_DESKTOP

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Finish([int]$code) {
  if (-not $Test) { Write-Host ''; [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') }
  exit $code
}

Write-Host ''
Say 'CallAudit1010 — доступ к сайту без прав администратора' Cyan
Write-Host ''

$candidates = @(
  @{ n = 'Google Chrome';   p = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" },
  @{ n = 'Google Chrome';   p = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" },
  @{ n = 'Google Chrome';   p = "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe" },
  @{ n = 'Яндекс Браузер';  p = "$env:LOCALAPPDATA\Yandex\YandexBrowser\Application\browser.exe" },
  @{ n = 'Яндекс Браузер';  p = "$env:ProgramFiles\Yandex\YandexBrowser\Application\browser.exe" },
  @{ n = 'Microsoft Edge';  p = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" },
  @{ n = 'Microsoft Edge';  p = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
)
$browser = $candidates | Where-Object { $_.p -and (Test-Path -LiteralPath $_.p) } | Select-Object -First 1
if (-not $browser) {
  Say 'Не нашёл ни Chrome, ни Яндекс Браузер, ни Edge.' Red
  Say 'Установите Google Chrome и запустите этот файл ещё раз.' Yellow
  Finish 1
}

$profileDir = Join-Path $env:LOCALAPPDATA 'CallAudit1010\browser'
$arguments = '--user-data-dir="' + $profileDir + '" ' +
             '--host-resolver-rules="MAP ' + $Name + ' ' + $Ip + '" ' +
             '--no-first-run --no-default-browser-check ' +
             '--app=' + $Url

try {
  $desktop = if ($Test) { $env:CA_DESKTOP } else { [Environment]::GetFolderPath('Desktop') }
  $lnkPath = Join-Path $desktop 'CallAudit1010.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath = $browser.p
  $lnk.Arguments = $arguments
  $lnk.WorkingDirectory = Split-Path -Parent $browser.p
  $lnk.IconLocation = $browser.p + ',0'
  $lnk.Description = 'CallAudit1010 — контроль качества'
  $lnk.Save()
} catch {
  Say 'Не получилось создать ярлык на рабочем столе:' Red
  Say ('  ' + $_.Exception.Message) Red
  Say 'Сделайте снимок этого окна и отправьте в чат.' Yellow
  Finish 1
}

Say ('Готово. На рабочем столе появился значок «CallAudit1010» (' + $browser.n + ').') Green
Say 'Открывайте сайт ТОЛЬКО через этот значок.' Green
# Firefox так не умеет, поэтому сайт откроется в другом браузере —
# говорим прямо, чтобы это не приняли за поломку
Say 'Firefox и всё остальное — как обычно, этот значок только для CallAudit1010.' Gray
Write-Host ''

if (-not $env:CA_NOLAUNCH) {
  Say 'Открываю сайт...' Gray
  Start-Process -FilePath $browser.p -ArgumentList $arguments
}
Finish 0
