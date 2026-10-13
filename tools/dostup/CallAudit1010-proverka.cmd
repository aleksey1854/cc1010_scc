@echo off
rem CallAudit1010: connection check for people who cannot open the site.
rem Double-click. Writes a report to the Desktop and opens it in Notepad.
rem Changes nothing on the computer. The body below the marker is PowerShell.
setlocal
set "CA_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:CA_SELF,[Text.Encoding]::UTF8); $i=$t.IndexOf([char]10+'#PS-START'); iex $t.Substring($i)"
exit /b %errorlevel%

#PS-START
# ------------------------------------------------------------------
# Проверка связи с сайтом CallAudit1010 изнутри сети сотрудника.
# Из дата-центров сайт открывается, а у части операторов в России — нет:
# режут или замедляют провайдеры. Чтобы понять, на каком шаге рвётся
# связь, проверяем по шагам: интернет вообще → адрес (DNS) → соединение
# с сервером → защищённое соединение → загрузка страницы целиком.
# Ничего не меняет на компьютере. Отчёт — на рабочий стол.
# ------------------------------------------------------------------
$ErrorActionPreference = 'Continue'
$lines = New-Object System.Collections.Generic.List[string]
function Out([string]$s, [string]$color = 'Gray') { $lines.Add($s); Write-Host $s -ForegroundColor $color }

Out 'CallAudit1010 — проверка связи с сайтом' Cyan
Out ('Время: ' + (Get-Date -Format 'dd.MM.yyyy HH:mm:ss') + ' · компьютер: ' + $env:COMPUTERNAME)
Out 'Подождите 1–2 минуты, ничего не закрывайте…' Yellow
Out ''

# --- адрес в интернете и сеть ---
try {
  $ip = (New-Object Net.WebClient).DownloadString('https://api.ipify.org')
  Out ('Внешний IP: ' + $ip.Trim())
} catch { Out 'Внешний IP: не удалось узнать' }
try {
  $up = Get-NetAdapter -ErrorAction Stop | Where-Object Status -eq 'Up' | ForEach-Object { $_.Name + ' (' + $_.InterfaceDescription + ')' }
  Out ('Активные подключения: ' + ($up -join '; '))
} catch { Out 'Активные подключения: не удалось узнать' }
try {
  $px = [Net.WebRequest]::DefaultWebProxy.GetProxy([Uri]'https://a1010.ru')
  if ($px.Host -ne 'a1010.ru') { Out ('Прокси в системе: ' + $px) } else { Out 'Прокси в системе: нет' }
} catch { }
Out ''

# --- одна проверка: DNS → TCP → TLS → загрузка страницы ---
function Check([string]$title, [string]$hostName, [string]$ipFixed, [string]$path) {
  Out ('== ' + $title) Cyan
  $ip = $ipFixed
  if (-not $ip) {
    try {
      $all = [Net.Dns]::GetHostAddresses($hostName) | Where-Object { $_.AddressFamily -eq 'InterNetwork' }
      $ip = ($all | Select-Object -First 1).IPAddressToString
      Out ('  адрес (DNS): ' + (($all | ForEach-Object { $_.IPAddressToString }) -join ', '))
    } catch { Out '  адрес (DNS): НЕ НАЙДЕН — интернет-провайдер не знает такого адреса' Red; return }
  } else { Out ('  адрес: ' + $ip + ' (напрямую)') }

  $tcp = New-Object Net.Sockets.TcpClient
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $iar = $tcp.BeginConnect($ip, 443, $null, $null)
  if (-not $iar.AsyncWaitHandle.WaitOne(10000)) {
    Out '  соединение: НЕТ за 10 с — до сервера не доходит (адрес заблокирован)' Red
    try { $tcp.Close() } catch { }
    return
  }
  try { $tcp.EndConnect($iar) } catch { Out ('  соединение: ОТКАЗ — ' + $_.Exception.InnerException.Message) Red; return }
  Out ('  соединение: есть, ' + $sw.ElapsedMilliseconds + ' мс') Green

  # таймаут на уровне соединения: рукопожатие не повиснет дольше 15 с
  $tcp.ReceiveTimeout = 15000; $tcp.SendTimeout = 15000
  # обычная проверка сертификата: если его подменяет провайдер или прокси —
  # это тоже важно увидеть
  $ssl = New-Object Net.Security.SslStream($tcp.GetStream(), $false)
  $ssl.ReadTimeout = 15000; $ssl.WriteTimeout = 15000
  $sw.Restart()
  try {
    # TLS 1.2 явно: старая PowerShell по умолчанию предлагает протоколы,
    # которые серверы давно не принимают
    $ssl.AuthenticateAsClient($hostName, $null, [Security.Authentication.SslProtocols]::Tls12, $false)
    Out ('  защищённое соединение (HTTPS): есть, ' + $sw.ElapsedMilliseconds + ' мс') Green
  } catch {
    $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
    $m = $e.Message
    $why = if ($m -match 'certificate|сертификат') { 'сертификат подменён — трафик перехватывает провайдер или прокси' }
           elseif ($sw.ElapsedMilliseconds -ge 14000) { 'тишина 15 с — провайдер глушит соединение по имени сайта' }
           else { 'соединение сброшено — провайдер обрывает по имени сайта' }
    Out ('  защищённое соединение (HTTPS): НЕ ПРОШЛО — ' + $why + ' [' + $m + ']') Red
    try { $tcp.Close() } catch { }
    return
  }

  $req = "GET $path HTTP/1.1`r`nHost: $hostName`r`nConnection: close`r`nUser-Agent: CallAudit1010-check`r`n`r`n"
  $b = [Text.Encoding]::ASCII.GetBytes($req)
  $sw.Restart()
  $got = 0; $first = $null; $stalled = $false
  $ms = New-Object IO.MemoryStream
  try {
    $ssl.Write($b, 0, $b.Length); $ssl.Flush()
    $buf = New-Object byte[] 16384
    while ($true) {
      $n = $ssl.Read($buf, 0, $buf.Length)
      if ($n -le 0) { break }
      if ($first -eq $null) { $first = $sw.ElapsedMilliseconds }
      $got += $n
      if ($ms.Length -lt 4096) { $ms.Write($buf, 0, [Math]::Min($n, 4096)) }
    }
  } catch { $stalled = $true }
  $head = [Text.Encoding]::ASCII.GetString($ms.ToArray())
  $status = ($head -split "`r`n")[0]
  $len = 0; if ($head -match 'Content-Length:\s*(\d+)') { $len = [int]$Matches[1] }
  $kb = [Math]::Round($got / 1024, 1)
  if ($stalled) {
    Out ('  загрузка: ЗАМЕРЛА — получено ' + $kb + ' КБ' + ($(if ($len) { ' из ' + [Math]::Round($len / 1024) + ' КБ' } else { '' })) +
         ', дальше тишина 15 с (так выглядит замедление со стороны провайдера). Ответ: ' + $status) Red
  } elseif (-not $status) {
    Out '  загрузка: сервер ничего не ответил' Red
  } else {
    Out ('  загрузка: ' + $status + ', ' + $kb + ' КБ за ' + $sw.ElapsedMilliseconds + ' мс') Green
  }
  try { $ssl.Close(); $tcp.Close() } catch { }
}

Check 'Контроль: ya.ru (российский сайт)' 'ya.ru' '' '/'
Check 'Сайт: a1010.ru' 'a1010.ru' '' '/'
Check 'Старый адрес: cc1010-scc.vercel.app' 'cc1010-scc.vercel.app' '' '/'
Check 'Сервер Vercel 76.76.21.21 напрямую' 'a1010.ru' '76.76.21.21' '/api/health'
Check 'Сервер Vercel 216.198.79.1 напрямую' 'a1010.ru' '216.198.79.1' '/api/health'

Out ''
$desk = [Environment]::GetFolderPath('Desktop')
$file = Join-Path $desk ('CallAudit1010-проверка-' + (Get-Date -Format 'ddMM-HHmm') + '.txt')
try {
  [IO.File]::WriteAllText($file, ($lines -join "`r`n"), (New-Object Text.UTF8Encoding($true)))
  Write-Host ('Отчёт сохранён на рабочий стол: ' + (Split-Path $file -Leaf)) -ForegroundColor Green
  Write-Host 'Отправьте этот файл (или скриншот этого окна) Арыстану и напишите, какой у вас интернет-провайдер.' -ForegroundColor Yellow
  Start-Process notepad.exe $file
} catch { Write-Host 'Не удалось сохранить отчёт — сделайте скриншот этого окна.' -ForegroundColor Red }
Write-Host ''
Read-Host 'Нажмите Enter, чтобы закрыть'
