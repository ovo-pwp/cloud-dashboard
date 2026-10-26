# cloud-dashboard PM2 keepalive (2026-10-23)
#
# Why this exists:
#   On 2026-10-21 ~21:32 the PM2 daemon disappeared and nobody noticed for 2 days.
#   The tunnel-watchdog lives INSIDE PM2, so when PM2 dies the watchdog dies too --
#   there was literally no layer left to recover anything.
#   This script runs from Windows Task Scheduler (outside any shell session / PM2),
#   so it survives whatever killed PM2.
#
# Logic: if nothing is listening on 127.0.0.1:3000, run pm2 resurrect.
#   Cheap TCP probe (not Test-NetConnection, which takes seconds).

$ErrorActionPreference = 'SilentlyContinue'

$node   = 'C:\Program Files\nodejs\node.exe'
$pm2js  = 'E:\Dev\npm-global\node_modules\pm2\bin\pm2'
$cwd    = 'C:\Users\Administrator\Desktop\cloud-dashboard'
$logDir = Join-Path $cwd 'logs'
$log    = Join-Path $logDir 'pm2-keepalive.log'

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Log($msg) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
}

function Test-Port3000 {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect('127.0.0.1', 3000, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(1500, $false)
    if (-not $ok) { $client.Close(); return $false }
    $client.EndConnect($iar)
    $client.Close()
    return $true
  } catch { return $false }
}

if (Test-Port3000) { exit 0 }   # healthy, stay quiet

Write-Log 'port 3000 not listening -> pm2 resurrect'

Set-Location $cwd
$out = & $node $pm2js resurrect 2>&1 | Out-String
$code = $LASTEXITCODE
# pm2 resurrect 会打印一�?ASCII 表格（含框线字符），整段记录既冗长又会乱码�?# 只留「是否恢复成功」的关键行，足够判断�?$brief = ($out -split "`n" | Where-Object { $_ -match 'restored|Resurrecting|error|Error' }) -join ' ; '
Write-Log ('resurrect exit=' + $code + ' ' + $brief.Trim())

Start-Sleep -Seconds 10
if (Test-Port3000) { Write-Log 'recovered: port 3000 is listening' }
else { Write-Log 'STILL DOWN after resurrect - need manual check (pm2 logs)' }
