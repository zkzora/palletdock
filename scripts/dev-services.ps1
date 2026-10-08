# Manage local PalletDock development services on Windows.
#   powershell -File scripts/dev-services.ps1 start   # api, worker, web (database must already run: pnpm db:start)
#   powershell -File scripts/dev-services.ps1 stop
#   powershell -File scripts/dev-services.ps1 status
# PIDs are stored in .data/<name>.pid and logs in .data/logs/<name>.{out,err}.log.
param([ValidateSet('start', 'stop', 'status', 'restart')][string]$Action = 'status', [string[]]$Only = @('api', 'worker', 'web'))

$Only = @($Only | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force .data\logs | Out-Null
if (-not $env:WEB_PORT -and (Test-Path .env)) {
  $line = Select-String -Path .env -Pattern '^WEB_PORT=(\d+)' | Select-Object -First 1
  if ($line) { $env:WEB_PORT = $line.Matches[0].Groups[1].Value }
}

$services = @{
  api    = @{ args = @('--filter', '@palletdock/api', 'start') }
  worker = @{ args = @('--filter', '@palletdock/worker', 'start') }
  web    = @{ args = @('--filter', '@palletdock/web', 'dev', '--port', $(if ($env:WEB_PORT) { $env:WEB_PORT } else { '3000' })) }
}

function Stop-Svc($name) {
  $f = ".data\$name.pid"
  if (Test-Path $f) {
    $procId = Get-Content $f
    & taskkill /T /F /PID $procId 2>$null | Out-Null
    Remove-Item $f -Force
    "stopped $name (pid $procId)"
  } else { "$name not running (no pid file)" }
}

function Start-Svc($name) {
  $s = $services[$name]
  $p = Start-Process -FilePath 'pnpm.cmd' -ArgumentList $s.args -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput ".data\logs\$name.out.log" -RedirectStandardError ".data\logs\$name.err.log"
  Set-Content ".data\$name.pid" $p.Id
  "started $name (pid $($p.Id))"
}

switch ($Action) {
  'start' { foreach ($n in $Only) { Start-Svc $n } }
  'stop' { foreach ($n in $Only) { Stop-Svc $n } }
  'restart' { foreach ($n in $Only) { Stop-Svc $n; Start-Svc $n } }
  'status' {
    foreach ($n in @('db') + $Only) {
      $f = ".data\$n.pid"
      if (Test-Path $f) {
        $procId = Get-Content $f
        $alive = [bool](Get-Process -Id $procId -ErrorAction SilentlyContinue)
        "{0,-7} pid {1,-6} {2}" -f $n, $procId, $(if ($alive) { 'running' } else { 'not running' })
      } else { "{0,-7} no pid file" -f $n }
    }
  }
}
