#!/bin/bash
# canary-system/scripts/inotify-watcher.sh
# Derived from: file-canary-engine/SKILL.md — inotify Fallback
# Use only when kernel version < 5.8 or eBPF is disabled

set -euo pipefail

CANARY_MAP="/opt/canary/config/canary-map.json"
ACCESS_LOG="/opt/canary/logs/access.log"

if [ ! -f "$CANARY_MAP" ]; then
  echo "Error: canary-map.json not found at $CANARY_MAP"
  exit 1
fi

CANARY_PATHS=$(jq -r '.canaries[].path' "$CANARY_MAP")

if [ -z "$CANARY_PATHS" ]; then
  echo "Error: No canary paths found in $CANARY_MAP"
  exit 1
fi

echo "Starting inotify watcher for $(echo "$CANARY_PATHS" | wc -l) canary files..."

# shellcheck disable=SC2086
inotifywait -m -e access,modify,attrib,delete,move \
  --format '%T %e %w%f' \
  --timefmt '%Y-%m-%dT%H:%M:%S' \
  $CANARY_PATHS 2>/dev/null | while read -r timestamp event file; do
    echo "{\"ts\":\"$timestamp\",\"event\":\"$event\",\"file\":\"$file\",\"type\":\"CANARY_FILE_EVENT\"}" \
      >> "$ACCESS_LOG"
done
