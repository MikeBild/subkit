#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

excluded=()
while read -r rule _; do
  [ -n "$rule" ] && excluded+=("--exclude-rule=$rule")
done < .semgrep-excluded-rules

semgrep scan --config p/default --metrics=off --error "${excluded[@]}" "$@" .
