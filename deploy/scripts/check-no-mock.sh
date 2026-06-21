#!/usr/bin/env bash
# Fail CI if web deliverables reference mock/recorded provider paths.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAIL=0

check() {
  local pattern="$1"
  local path="$2"
  if rg -n "$pattern" "$path" 2>/dev/null; then
    echo "FAIL: forbidden pattern '$pattern' in $path"
    FAIL=1
  fi
}

for dir in deploy/docker apps/agent-runtime services/platform-java apps/web; do
  if [[ -d "$ROOT/$dir" ]]; then
    check 'ACADEMIC_AGENT_RECORDED_PROVIDER=1' "$ROOT/$dir"
    check 'RecordedProvider' "$ROOT/$dir"
    check 'mock-idea-diagnoser' "$ROOT/$dir"
  fi
done

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
echo "OK: no mock/recorded patterns in web deliverables"
