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
# старая PowerShell по умолчанию ходит по устаревшему TLS — сервисы её не пускают
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
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
try {
  $org = (New-Object Net.WebClient).DownloadString('https://ipinfo.io/org')
  Out ('Провайдер по внешнему IP: ' + $org.Trim())
} catch { }

# --- рабочий VPN (OpenVPN от Октелла): при нём адрес сайта может отдавать
# DNS-сервер VPN, а сам трафик — идти через VPN, а не через домашний интернет ---
try {
  $vpn = @(Get-NetAdapter -ErrorAction Stop | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -match 'TAP|OpenVPN|Wintun|WireGuard|VPN|TUN' })
  if ($vpn.Count) { Out ('VPN: ВКЛЮЧЁН — ' + (($vpn | ForEach-Object { $_.Name }) -join '; ')) Yellow } else { Out 'VPN: выключен' }
} catch { }
$dnsList = @()
try {
  Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.ServerAddresses.Count } | ForEach-Object {
    $ad = Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue
    if ($ad -and $ad.Status -eq 'Up') {
      Out ('DNS-серверы (' + $_.InterfaceAlias + '): ' + ($_.ServerAddresses -join ', '))
      $dnsList += $_.ServerAddresses
    }
  }
} catch { Out 'DNS-серверы: не удалось узнать' }
try {
  $hf = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
  $hl = @(Get-Content $hf -ErrorAction Stop | Where-Object { $_ -match 'a1010|vercel' -and $_ -notmatch '^\s*#' })
  if ($hl.Count) { Out ('Файл hosts: ' + ($hl -join ' | ')) Yellow } else { Out 'Файл hosts: записей про сайт нет' }
} catch { }
Out ''

# --- что каждый DNS-сервер отвечает про сайт: у сервера VPN ответ может
# отставать от остальных (старый адрес держится в его памяти) ---
Out '== Что отвечают DNS-серверы про a1010.ru' Cyan
$names = @{ '77.88.8.8' = ' (Яндекс)'; '8.8.8.8' = ' (Google)' }
foreach ($s in (@($dnsList) + @('77.88.8.8', '8.8.8.8') | Select-Object -Unique)) {
  try {
    $a = @(Resolve-DnsName a1010.ru -Type A -Server $s -DnsOnly -NoHostsFile -QuickTimeout -ErrorAction Stop | Where-Object { $_.Type -eq 'A' })
    Out ('  ' + $s + $names[$s] + ': ' + (($a | ForEach-Object { $_.IPAddress }) -join ', '))
  } catch { Out ('  ' + $s + $names[$s] + ': нет ответа') Red }
}
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
  # через какое подключение уходит трафик: домашний интернет или VPN
  try {
    $rt = Find-NetRoute -RemoteIPAddress $ip -ErrorAction Stop | Where-Object { $_.InterfaceAlias } | Select-Object -First 1
    if ($rt) { Out ('  идёт через: ' + $rt.InterfaceAlias) }
  } catch { }

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
$desk = if ($env:CA_OUT) { $env:CA_OUT } else { [Environment]::GetFolderPath('Desktop') }
$file = Join-Path $desk ('CallAudit1010-проверка-' + (Get-Date -Format 'ddMM-HHmm') + '.txt')
try {
  [IO.File]::WriteAllText($file, ($lines -join "`r`n"), (New-Object Text.UTF8Encoding($true)))
  Write-Host ('Отчёт сохранён на рабочий стол: ' + (Split-Path $file -Leaf)) -ForegroundColor Green
  Write-Host 'Отправьте этот файл (или скриншот этого окна) Арыстану и напишите, какой у вас интернет-провайдер.' -ForegroundColor Yellow
  if (-not $env:CA_OUT) { Start-Process notepad.exe $file }
} catch { Write-Host 'Не удалось сохранить отчёт — сделайте скриншот этого окна.' -ForegroundColor Red }
Write-Host ''
# CA_OUT — прогон для проверки самого файла: без Блокнота и ожидания Enter
if (-not $env:CA_OUT) { Read-Host 'Нажмите Enter, чтобы закрыть' }
