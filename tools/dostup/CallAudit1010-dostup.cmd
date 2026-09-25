@echo off
rem CallAudit1010: access fix for providers in Russia that block one of the
rem Vercel IP addresses. Adds "76.76.21.21 cc1010-scc.vercel.app" to hosts.
rem Double-click to run. "remove" as the first argument undoes the change.
rem The script body below the marker is PowerShell; this header stays ASCII.
setlocal
set "CA_SELF=%~f0"
set "CA_MODE=add"
if /i "%~1"=="remove" set "CA_MODE=remove"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:CA_SELF,[Text.Encoding]::UTF8); $i=$t.IndexOf([char]10+'#PS-START'); iex $t.Substring($i)"
exit /b %errorlevel%

#PS-START
# ------------------------------------------------------------------
# У cc1010-scc.vercel.app два адреса Vercel, и часть российских
# провайдеров режет один из них (216.198.79.3): браузер попадает на него
# и пишет «соединение сброшено». Строка в hosts велит компьютеру всегда
# ходить на доступный адрес 76.76.21.21 — тот же Vercel, тот же сайт,
# сертификат настоящий. Это временная мера до своего домена.
# ------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$Name  = 'cc1010-scc.vercel.app'
$Ip    = '76.76.21.21'
$Tag   = '# CallAudit1010'
$Mode  = $env:CA_MODE
# CA_HOSTS — только для проверки на копии: тогда настоящий hosts не трогаем
$Test  = [bool]$env:CA_HOSTS
$Hosts = if ($Test) { $env:CA_HOSTS } else { Join-Path $env:SystemRoot 'System32\drivers\etc\hosts' }

function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Finish([int]$code) {
  if (-not $Test) { Write-Host ''; [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') }
  exit $code
}

Write-Host ''
Say 'CallAudit1010 — доступ к сайту' Cyan
Write-Host ''

# права администратора: без них hosts не изменить — просим сами
if (-not $Test) {
  $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Say 'Нужны права администратора — сейчас Windows спросит разрешение.' Yellow
    try {
      $arg = if ($Mode -eq 'remove') { 'remove' } else { '' }
      if ($arg) { Start-Process -FilePath $env:CA_SELF -ArgumentList $arg -Verb RunAs }
      else      { Start-Process -FilePath $env:CA_SELF -Verb RunAs }
      exit 0
    } catch {
      Say 'Разрешение не дали — ничего не изменено.' Red
      Finish 1
    }
  }
}

try {
  $lines = @()
  if (Test-Path -LiteralPath $Hosts) { $lines = @(Get-Content -LiteralPath $Hosts) }

  # копия прежнего файла — один раз, чтобы не затереть настоящий оригинал
  $backup = "$Hosts.callaudit-backup"
  if ((Test-Path -LiteralPath $Hosts) -and -not (Test-Path -LiteralPath $backup)) {
    Copy-Item -LiteralPath $Hosts -Destination $backup
  }

  # наши прежние строки и любые строки для этого же имени убираем,
  # чтобы от повторного запуска не копились дубли
  $pattern = '(^|\s)' + [regex]::Escape($Name) + '(\s|$)'
  $kept = @($lines | Where-Object {
    $s = $_.Trim()
    -not ($s.Contains($Tag)) -and -not (-not $s.StartsWith('#') -and $s -match $pattern)
  })

  if ($Mode -eq 'remove') {
    $new = $kept
  } else {
    $new = $kept + ("$Ip`t$Name`t$Tag")
  }

  $item = if (Test-Path -LiteralPath $Hosts) { Get-Item -LiteralPath $Hosts } else { $null }
  $wasReadOnly = $item -and $item.IsReadOnly
  if ($wasReadOnly) { $item.IsReadOnly = $false }
  Set-Content -LiteralPath $Hosts -Value $new -Encoding Default
  if ($wasReadOnly) { (Get-Item -LiteralPath $Hosts).IsReadOnly = $true }
} catch {
  Say 'Не получилось изменить файл hosts:' Red
  Say ('  ' + $_.Exception.Message) Red
  Write-Host ''
  Say 'Обычно его защищает антивирус. Попросите техспециалиста разрешить' Yellow
  Say 'изменение или вписать строку вручную в конец файла' Yellow
  Say ("  $Hosts") Yellow
  Say ("  $Ip $Name") Yellow
  Finish 1
}

if (-not $Test) { ipconfig /flushdns | Out-Null }

if ($Mode -eq 'remove') {
  Say 'Готово: строка для сайта убрана, всё как было.' Green
  Finish 0
}

Say "Готово: компьютер будет открывать сайт через адрес $Ip." Green
Write-Host ''
Say 'Проверяю, открывается ли сайт...' Gray
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $r = Invoke-WebRequest -Uri "https://$Name/" -UseBasicParsing -TimeoutSec 20
  if ($r.StatusCode -eq 200) {
    Say 'Сайт открывается.' Green
    Write-Host ''
    Say 'Закройте браузер полностью (все окна), откройте снова' Gray
    Say "и зайдите на https://$Name" Gray
    Finish 0
  }
  Say ('Сайт ответил кодом ' + $r.StatusCode + ' — напишите об этом в чат.') Yellow
  Finish 2
} catch {
  Say 'Сайт всё ещё не открывается:' Yellow
  Say ('  ' + $_.Exception.Message) Yellow
  Write-Host ''
  Say 'Сделайте снимок этого окна и отправьте в чат — посмотрим.' Yellow
  Finish 2
}
