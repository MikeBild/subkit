#!/usr/bin/env bash
# Lightweight conventional-commit check, no external deps.
#
# Mirrors the rules in commitlint.config.json:
#   - header-max-length: 100
#   - type-enum: feat|fix|docs|chore|refactor|perf|test|build|ci|style|revert
#   - subject-case (config-conventional default): subject must not be
#     sentence-case / start-case / pascal-case / upper-case — i.e. the
#     first word after `<type>(<scope>): ` must NOT start with a
#     capital letter (allow non-ASCII letters since names like "OAuth"
#     ARE valid in this repo's history; restrict only A-Z first char).
#
# Pass either:
#   - a file path containing the message (commit-msg hook)
#   - --range FROM..TO  (pre-push hook)
#   - --sha COMMIT_SHA  (single commit)

set -e

MAX_LEN=100
TYPE_RE='^(feat|fix|docs|chore|refactor|perf|test|build|ci|style|revert)(\([a-z0-9_/-]+\))?!?: '

check_one() {
  local header="$1"
  local label="$2"

  # Skip merge / revert / fixup messages — git generates these.
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
  # subject = everything after the first ': '
  local subject="${header#*: }"
  local first_char="${subject:0:1}"
  # Use [[:upper:]] explicitly: glob `[A-Z]` matches lowercase too
  # under non-POSIX locales (e.g. en_US.UTF-8), which would falsely
  # flag valid lowercase subjects.
  case "$first_char" in
    [[:upper:]])
      echo "✖ ${label}: subject must not start uppercase (sentence/start/pascal-case): $header" >&2
      return 1
      ;;
  esac
  return 0
}

if [ "$1" = "--range" ]; then
  range="$2"
  failed=0
  while IFS= read -r line; do
    sha="${line%% *}"
    header="${line#* }"
    if ! check_one "$header" "$sha"; then failed=1; fi
  done < <(git log --format='%h %s' "$range")
  exit "$failed"
fi

if [ "$1" = "--sha" ]; then
  header=$(git log -1 --format='%s' "$2")
  check_one "$header" "$2"
  exit $?
fi

# Default: file path
msg_file="$1"
[ -z "$msg_file" ] && exit 0
[ ! -f "$msg_file" ] && exit 0
header=$(head -n1 "$msg_file")
check_one "$header" "(commit-msg)"
