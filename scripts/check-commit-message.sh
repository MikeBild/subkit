#!/usr/bin/env bash

set -e

MAX_LEN=100
TYPE_RE='^(feat|fix|docs|chore|refactor|perf|test|build|ci|style|revert)(\([a-z0-9_/-]+\))?!?: '

check_one() {
  local header="$1"
  local label="$2"

  case "$header" in
    "Merge "*|"Revert "*|"fixup!"*|"squash!"*|"amend!"*)
      return 0
      ;;
  esac

  if [ ${#header} -gt $MAX_LEN ]; then
    echo "✖ ${label}: header exceeds ${MAX_LEN} chars (${#header}): $header" >&2
    return 1
  fi
  if ! [[ "$header" =~ $TYPE_RE ]]; then
    echo "✖ ${label}: header doesn't match conventional-commit type-enum" >&2
    echo "  expected '<type>(<scope>): <subject>' where type is one of feat|fix|docs|chore|refactor|perf|test|build|ci|style|revert" >&2
    echo "  got: $header" >&2
    return 1
  fi
  local subject="${header#*: }"
  local first_char="${subject:0:1}"
  case "$first_char" in
    [[:upper:]])
      echo "✖ ${label}: subject must not start uppercase (sentence/start/pascal-case): $header" >&2
      return 1
      ;;
  esac
  return 0
}

ATTRIBUTION_RE='^(Claude-Session:|Co-Authored-By:.*[Cc]laude|.*Generated with \[?Claude Code)'

check_body() {
  local body="$1"
  local label="$2"
  if printf '%s\n' "$body" | grep -qE "$ATTRIBUTION_RE"; then
    echo "✖ ${label}: commit message carries an assistant attribution line; remove it" >&2
    return 1
  fi
  return 0
}

if [ "$1" = "--range" ]; then
  range="$2"
  log=$(git log --format='%h %s' "$range") || exit $?
  [ -z "$log" ] && exit 0
  failed=0
  while IFS= read -r line; do
    sha="${line%% *}"
    header="${line#* }"
    if ! check_one "$header" "$sha"; then failed=1; fi
    if ! check_body "$(git log -1 --format='%B' "$sha")" "$sha"; then failed=1; fi
  done <<< "$log"
  exit "$failed"
fi

if [ "$1" = "--sha" ]; then
  header=$(git log -1 --format='%s' "$2")
  check_one "$header" "$2" || exit 1
  check_body "$(git log -1 --format='%B' "$2")" "$2"
  exit $?
fi

msg_file="$1"
[ -z "$msg_file" ] && exit 0
[ ! -f "$msg_file" ] && exit 0
header=$(head -n1 "$msg_file")
check_one "$header" "(commit-msg)" || exit 1
check_body "$(grep -v '^#' "$msg_file")" "(commit-msg)"
