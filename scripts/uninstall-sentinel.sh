#!/usr/bin/env bash
# uninstall-sentinel.sh - remove the Sentinel agent and everything install-sentinel.sh created.
#
#   curl -fsSLk https://<backend>/downloads/uninstall-sentinel.sh | sudo bash -s -- --yes
#
# Options:
#   --yes             do not prompt (also implied when there is no terminal)
#   --dry-run         print what would be done, change nothing (root not required)
#   --purge-auditd    also remove the auditd packages (off by default: other tools may use auditd)
#
# What it removes: the systemd service, the auditd plugin + rules (live and persisted), the planted
# decoy files (only files carrying the deployer's __CANARY_ID__= marker), and /opt/canary,
# /opt/sentinel, /etc/canary, /var/lib/canary, /run/canary. It does not touch the backend; to retire the
# server-side record use POST /api/v1/agents/{agent_id}/decommission.
#
# Best-effort by design: a failed step is reported and the rest still run, so a half-installed host
# can still be cleaned. Exit status is non-zero if anything failed.
set -uo pipefail

ASSUME_YES=0; DRY_RUN=0; PURGE_AUDITD=0
for a in "$@"; do
  case "$a" in
    --yes|-y)       ASSUME_YES=1 ;;
    --dry-run)      DRY_RUN=1 ;;
    --purge-auditd) PURGE_AUDITD=1 ;;
    -h|--help)      sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: unknown argument: $a" >&2; exit 2 ;;
  esac
done

# Must match install-sentinel.sh.
INSTALL_DIR="/opt/canary"
SENTINEL_DIRS="/opt/canary /opt/sentinel /etc/canary /var/lib/canary /run/canary"
UNIT="/etc/systemd/system/sentinel.service"
PLUGIN_FILES="/etc/audit/plugins.d/sentinel.conf /etc/audisp/plugins.d/sentinel.conf"
RULES_FILE="/etc/audit/rules.d/canary.rules"
PIDFILE="/run/canary/sentinel-a.pid"
MARKER="__CANARY_ID__="
FAILED=0

say()  { printf '[*] %s\n' "$*"; }
warn() { printf '[!] %s\n' "$*" >&2; FAILED=1; }
# run: execute a command, or just print it in --dry-run. A failure is reported, never fatal.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then printf '    (dry-run) %s\n' "$*"; return 0; fi
  "$@" || { warn "failed: $*"; return 1; }
}

if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root (use sudo), or pass --dry-run." >&2; exit 1
fi

if [ "$ASSUME_YES" -eq 0 ] && [ "$DRY_RUN" -eq 0 ] && [ -r /dev/tty ]; then
  printf 'This removes the Sentinel agent, its audit rules and planted decoy files from this host. Continue? [y/N] ' > /dev/tty
  read -r reply < /dev/tty
  case "$reply" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 1 ;; esac
fi

# --- 0. Decoy target directories, read from the installed profiles BEFORE config is deleted ---
DECOY_DIRS=""
for f in "${INSTALL_DIR}"/config/profiles/*.yaml "${INSTALL_DIR}"/config/*.yaml; do
  [ -f "$f" ] || continue
  DECOY_DIRS="${DECOY_DIRS}
$(sed -n 's/^[[:space:]]*-[[:space:]]*path:[[:space:]]*\(\/[^[:space:]#]*\).*/\1/p' "$f")"
done
DECOY_DIRS="$(printf '%s\n' "$DECOY_DIRS" | sed '/^$/d' | sort -u)"

# --- 1. Stop the service ---
say "Stopping the sentinel service..."
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  if systemctl list-unit-files sentinel.service >/dev/null 2>&1 || [ -f "$UNIT" ]; then
    run systemctl disable --now sentinel.service
  fi
  [ -f "$UNIT" ] && run rm -f "$UNIT"
  run systemctl daemon-reload
  run systemctl reset-failed sentinel.service 2>/dev/null
else
  # No systemd: stop by pidfile, then by name.
  if [ -f "$PIDFILE" ]; then run kill "$(cat "$PIDFILE")" 2>/dev/null; fi
  [ -f "$UNIT" ] && run rm -f "$UNIT"
fi
# The agent also runs as an auditd plugin process; make sure nothing is left.
run pkill -f "${INSTALL_DIR}/sentinel" 2>/dev/null || true

# --- 2. Auditd plugin ---
say "Removing the auditd plugin..."
for p in $PLUGIN_FILES; do [ -e "$p" ] && run rm -f "$p"; done
# auditd re-reads plugins on SIGHUP; this drops our plugin without restarting auditd
# (RHEL-family units refuse 'service auditd restart').
if pidof auditd >/dev/null 2>&1; then run kill -HUP "$(pidof auditd | awk '{print $1}')" 2>/dev/null; fi
run pkill -f "${INSTALL_DIR}/sentinel audit-consume" 2>/dev/null || true

# --- 3. Audit rules: persisted file, then any live rule carrying one of our keys ---
say "Removing Canary audit rules..."
[ -e "$RULES_FILE" ] && run rm -f "$RULES_FILE"
if command -v auditctl >/dev/null 2>&1; then
  # Our keys: sys-integrity (decoy watches), canary_tamper / sentinel_tamper (installer rules).
  # Turn each '-w <path> ... -k <key>' into the matching '-W' delete; works for any path.
  while IFS= read -r rule; do
    [ -n "$rule" ] || continue
    # shellcheck disable=SC2086  # intentional word splitting of the rule's arguments
    run auditctl $(printf '%s' "$rule" | sed 's/^-w /-W /')
  done < <(auditctl -l 2>/dev/null | grep -E -- '^-w .* -k (sys-integrity|canary_tamper|sentinel_tamper)$')
fi

# --- 4. Planted decoy files (marker-bearing files only; never anything else) ---
say "Removing planted decoy files..."
REMOVED=0
while IFS= read -r d; do
  [ -d "$d" ] || continue
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    run rm -f -- "$file" && REMOVED=$((REMOVED + 1))
  done < <(find "$d" -maxdepth 2 -type f -size -1024k -exec grep -lF -- "$MARKER" {} + 2>/dev/null)
  # Remove the directory only if it is now empty (the installer may have created it).
  [ "$DRY_RUN" -eq 0 ] && rmdir "$d" 2>/dev/null
done <<< "$DECOY_DIRS"
say "Decoy files removed: ${REMOVED}"

# --- 5. Agent files, config, certs and state ---
say "Deleting agent files and state..."
for d in $SENTINEL_DIRS; do [ -e "$d" ] && run rm -rf -- "$d"; done

# --- 6. Optional: auditd packages ---
if [ "$PURGE_AUDITD" -eq 1 ]; then
  say "Removing auditd packages (--purge-auditd)..."
  if   command -v apt-get >/dev/null 2>&1; then run env DEBIAN_FRONTEND=noninteractive apt-get remove -y auditd audispd-plugins </dev/null
  elif command -v dnf     >/dev/null 2>&1; then run dnf remove -y audit audispd-plugins </dev/null
  elif command -v yum     >/dev/null 2>&1; then run yum remove -y audit audispd-plugins </dev/null
  else warn "no supported package manager found; auditd left installed"; fi
fi

# --- 7. Verify ---
if [ "$DRY_RUN" -eq 0 ]; then
  LEFT=0
  pgrep -f "${INSTALL_DIR}/sentinel" >/dev/null 2>&1 && { warn "sentinel process still running"; LEFT=1; }
  for d in $SENTINEL_DIRS "$UNIT" "$RULES_FILE" $PLUGIN_FILES; do [ -e "$d" ] && { warn "still present: $d"; LEFT=1; }; done
  if command -v auditctl >/dev/null 2>&1 && auditctl -l 2>/dev/null | grep -qE -- '-k (sys-integrity|canary_tamper|sentinel_tamper)$'; then
    warn "live audit rules with Canary keys remain (auditd may be in immutable mode: reboot to clear)"; LEFT=1
  fi
  [ "$LEFT" -eq 0 ] && say "Verified: no sentinel process, files, unit, plugin or audit rules remain."
fi

if [ "$FAILED" -eq 0 ]; then say "Sentinel uninstalled."; else echo "[!] Finished with warnings above." >&2; fi
echo "    Server side: decommission the agent in the UI/API (POST /api/v1/agents/{id}/decommission) to retire its record."
exit "$FAILED"
