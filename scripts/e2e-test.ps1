$ErrorActionPreference = 'Stop'

$env:SENTINEL_LOCAL_KEY="0000000000000000000000000000000000000000000000000000000000000001"

Write-Host "=== Compiling Sentinel ==="
$env:GO111MODULE="on"
$env:GOOS="linux"
$env:GOARCH="amd64"
Set-Location src/sentinel
go build -o ../../test-env/sentinel-a ./cmd/sentinel-a
Set-Location ../..

Write-Host "=== Starting E2E Mock Ingestion Server ==="
$env:GOOS=""
$env:GOARCH=""
Remove-Item -Force scripts/e2e-success.tmp -ErrorAction Ignore
Remove-Item -Force scripts/mock-server.log -ErrorAction Ignore
Remove-Item -Force scripts/mock-server-err.log -ErrorAction Ignore

# Start the mock server in the background
$mockProcess = Start-Process -FilePath "go" -ArgumentList "run mock-server.go" -WorkingDirectory "scripts" -RedirectStandardOutput "scripts\mock-server.log" -RedirectStandardError "scripts\mock-server-err.log" -PassThru -WindowStyle Hidden

Write-Host "Waiting for mock server to start..."
Start-Sleep -Seconds 2

try {
    Write-Host "=== Deploying and Starting Sentinel in VM ==="
    Set-Location test-env
    vagrant ssh -c "sudo systemctl stop sentinel; sudo pkill -9 sentinel-a || true"
    vagrant ssh -c "sudo cp /vagrant/sentinel-a /usr/local/bin/sentinel-a && sudo chmod +x /usr/local/bin/sentinel-a"

    # Run Sentinel in background in dev mode
    vagrant ssh -c "export SENTINEL_LOCAL_KEY=$env:SENTINEL_LOCAL_KEY; sudo -E /usr/local/bin/sentinel-a -dev -config /opt/sentinel/config/sentinel.yaml > /tmp/sentinel.log 2>&1 &"

    Write-Host "Waiting for Sentinel to boot..."
    Start-Sleep -Seconds 3

    Write-Host "=== Triggering Audit Event via audit-consume ==="
    $auditLines = @"
type=SYSCALL msg=audit(1714295828.000:123): arch=c000003e syscall=2 success=yes exit=3 a0=7ffcd5a2b000 a1=0 a2=0 a3=0 items=1 ppid=1234 pid=5678 auid=1000 uid=1000 gid=1000 euid=1000 suid=1000 fsuid=1000 egid=1000 sgid=1000 fsgid=1000 tty=pts0 ses=1 comm=`"cat`" exe=`"/usr/bin/cat`" key=`"canary`"
type=PATH msg=audit(1714295828.000:123): item=0 name=`"/etc/shadow`" inode=1234 dev=08:01 mode=0100600 ouid=0 ogid=0 rdev=00:00 nametype=NORMAL cap_fp=0 cap_fi=0 cap_fe=0 cap_fver=0 cap_frootid=0
"@
    Set-Content audit.log $auditLines -Encoding ascii
    vagrant ssh -c "sudo cp /vagrant/audit.log /tmp/audit.log"
    # Feed the audit log with a timeout to prevent hanging
    vagrant ssh -c "timeout 15s bash -c '(cat /tmp/audit.log; sleep 5) | sudo /usr/local/bin/sentinel-a audit-consume > /tmp/consume.log 2>&1' || true"
    Remove-Item audit.log -ErrorAction Ignore
    Set-Location ..

    Write-Host "=== Verifying Event Reception ==="
    Start-Sleep -Seconds 2

    $logContent = Get-Content scripts\mock-server.log -ErrorAction Ignore
    $errLogContent = Get-Content scripts\mock-server-err.log -ErrorAction Ignore
    $allLogs = "$logContent`n$errLogContent"

    if ($allLogs -match "Received event") {
        Write-Host "------------------------------------------------"
        Write-Host "SUCCESS: E2E Test Passed. Event was received by mock server."
        Write-Host $allLogs | Select-String -Pattern "Received event"
        Write-Host "------------------------------------------------"
        exit 0
    } else {
        Write-Host "------------------------------------------------"
        Write-Host "FAILURE: E2E Test Failed. No event received."
        Write-Host "Sentinel Log:"
        Set-Location test-env
        vagrant ssh -c "tail -n 20 /tmp/sentinel.log"
        Set-Location ..
        Write-Host "Mock Server Log:"
        Get-Content scripts\mock-server.log
        Write-Host "------------------------------------------------"
        exit 1
    }
} finally {
    Write-Host "Cleaning up mock server (PID $($mockProcess.Id))..."
    Stop-Process -Id $mockProcess.Id -Force -ErrorAction Ignore
}
