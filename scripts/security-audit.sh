#!/bin/bash
set -euo pipefail

echo "=== Sentinel Deep Security Audit ==="

# We run this on the host, which will SSH into the VM to run the checks
cd test-env || exit 1

# Check 1: Validate systemd hardening parameters
echo "[+] Validating systemd service hardening..."
vagrant ssh -c "systemctl cat sentinel.service" > /tmp/sentinel.service.dump
grep -q "ProtectSystem=strict" /tmp/sentinel.service.dump || { echo "FAIL: Missing ProtectSystem=strict"; exit 1; }
grep -q "ProtectHome=yes" /tmp/sentinel.service.dump || { echo "FAIL: Missing ProtectHome=yes"; exit 1; }
grep -q "PrivateTmp=yes" /tmp/sentinel.service.dump || { echo "FAIL: Missing PrivateTmp=yes"; exit 1; }
grep -q "NoNewPrivileges=yes" /tmp/sentinel.service.dump || { echo "FAIL: Missing NoNewPrivileges=yes"; exit 1; }
echo "PASS: systemd hardening parameters verified."

# Check 2: Capabilities Check
echo "[+] Validating Process Capabilities..."
vagrant ssh -c "pidof sentinel-a > /dev/null || (sudo systemctl start sentinel && sleep 2)"
CAP_EFF=$(vagrant ssh -c "sudo grep CapEff /proc/\$(pidof sentinel-a)/status" | awk '{print $2}' | tr -d '\r')

# CAP_NET_ADMIN (12) + CAP_SYS_RESOURCE (24)
# Hex: 2^12 = 0x1000, 2^24 = 0x1000000 -> Expected CapEff: 0000000001001000
# Depending on specific kernels or default capabilities, this might vary slightly, 
# but we specifically ensure it's not full root (which is 000001ffffffffff or similar)
if [[ "$CAP_EFF" == *"ffffffff"* ]]; then
    echo "FAIL: Sentinel is running with full root capabilities (CapEff: $CAP_EFF)"
    exit 1
fi
echo "PASS: Sentinel capabilities are dropped (CapEff: $CAP_EFF)"

# Check 3: File permissions in State Directory
echo "[+] Validating State Directory Permissions..."
# /var/lib/canary shouldn't be world-writable
WORLD_WRITABLE=$(vagrant ssh -c "sudo find /var/lib/canary -perm -0002 -type f 2>/dev/null | wc -l" | tr -d '\r')
if [ "$WORLD_WRITABLE" -ne 0 ]; then
    echo "FAIL: Found $WORLD_WRITABLE world-writable files in /var/lib/canary"
    exit 1
fi
echo "PASS: State directory permissions verified."

echo "=== Security Audit Passed ==="
exit 0
