<#
.SYNOPSIS
  把本机 PostgreSQL 里的历史数据搬到云服务器（可选步骤）

.DESCRIPTION
  服务器自己就能从金山文档同步数据，所以这一步只为「保留历史快照」——
  比如「每日趋势」页要看的多天曲线，新服务器上是没有的。

  流程：本机 pg_dump → scp 上传 → 在服务器上 psql 导入（覆盖现有同名表）

  在本地 Windows 上执行，不是在服务器上执行。

.EXAMPLE
  .\push-local-data.ps1 -Server 1.2.3.4
  .\push-local-data.ps1 -Server kanban.example.com -SshUser ubuntu -RemoteDir /home/ubuntu/cloud-dashboard
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$SshUser = 'root',
  [string]$RemoteDir = '/root/cloud-dashboard',
  [string]$DbUser = 'cloud_dashboard',
  [string]$DbName = 'cloud_dashboard',
  [string]$PgDump = ''
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# ---------- 1. 找 pg_dump ----------
if (-not $PgDump) {
  $candidates = @()
  $candidates += Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
  $candidates += (Get-Command pg_dump -ErrorAction SilentlyContinue).Source
  $PgDump = ($candidates | Where-Object { $_ } | Select-Object -First 1)
}
if (-not $PgDump -or -not (Test-Path $PgDump)) {
  throw "找不到 pg_dump。请用 -PgDump 指定，例如：`n  -PgDump 'C:\Program Files\PostgreSQL\16\bin\pg_dump.exe'"
}
Write-Host "使用 pg_dump: $PgDump" -ForegroundColor Cyan

# ---------- 2. 从项目根 .env 读本机 DATABASE_URL ----------
$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
if (-not (Test-Path $envFile)) { throw "找不到 $envFile，无法得知本机数据库连接串" }

$line = Get-Content $envFile | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1
if (-not $line) { throw "项目 .env 里没有 DATABASE_URL" }
$localUrl = ($line -replace '^\s*DATABASE_URL\s*=\s*', '').Trim().Trim('"').Trim("'")
Write-Host "本机数据库: $($localUrl -replace ':[^:@/]+@', ':***@')" -ForegroundColor Cyan

# ---------- 3. 导出 ----------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$name  = "$DbName-$stamp.sql"
$tmp   = Join-Path $env:TEMP $name
$staging = Join-Path $PSScriptRoot 'backups'
New-Item -ItemType Directory -Force -Path $staging | Out-Null
$local = Join-Path $staging $name

Write-Host "`n==> 正在从本机导出 ..." -ForegroundColor Cyan
& $PgDump --dbname=$localUrl --clean --if-exists --no-owner --no-privileges --encoding=UTF8 -f $tmp
if ($LASTEXITCODE -ne 0) { throw "pg_dump 失败（退出码 $LASTEXITCODE）" }
$size = [math]::Round((Get-Item $tmp).Length / 1KB, 1)
Write-Host "    导出完成：$size KB"

Move-Item -Force $tmp $local

# ---------- 4. 上传 ----------
$remote = "/tmp/$name"
Write-Host "`n==> 正在上传到 ${SshUser}@${Server}:$remote ..." -ForegroundColor Cyan
& scp $local "${SshUser}@${Server}:$remote"
if ($LASTEXITCODE -ne 0) { throw "scp 上传失败（退出码 $LASTEXITCODE）" }

# ---------- 5. 导入 ----------
# 注意：整个远程命令用双引号包住，`< $remote` 由服务器端 shell 解析重定向
$remoteCmd = "docker compose -f $RemoteDir/deploy/docker-compose.yml exec -T db " +
             "psql -U $DbUser -d $DbName -v ON_ERROR_STOP=1 < $remote && rm -f $remote"

Write-Host "`n==> 正在导入到服务器数据库（会覆盖同名表）..." -ForegroundColor Cyan
& ssh "${SshUser}@${Server}" $remoteCmd
if ($LASTEXITCODE -ne 0) { throw "远程导入失败（退出码 $LASTEXITCODE）" }

Write-Host "`n✔ 完成。本地导出的副本保留在：$local" -ForegroundColor Green
Write-Host "  打开站点确认数据，然后到「系统管理」页点一次「立即同步」刷新快照。"
