# Stop the isolated E2E fixture stack started with `pnpm e2e:stack` (Windows).
# Kills the stack's process tree and its temporary PostgreSQL; leaves dev services alone.
$all = Get-CimInstance Win32_Process
$all | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*e2e-stack.ts*' } | ForEach-Object {
  & taskkill /T /F /PID $_.ProcessId 2>$null | Out-Null
  "stopped e2e stack pid $($_.ProcessId)"
}
foreach ($port in 3199, 4199, 8599) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($c) { & taskkill /T /F /PID $c.OwningProcess 2>$null | Out-Null; "stopped listener on $port" }
}
$all | Where-Object { $_.Name -eq 'postgres.exe' -and $_.CommandLine -like '*palletdock-e2e-pg*' } | ForEach-Object {
  & taskkill /T /F /PID $_.ProcessId 2>$null | Out-Null
  "stopped e2e postgres pid $($_.ProcessId)"
}
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path (Split-Path -Parent $PSScriptRoot) '.data\e2e\state.json')
