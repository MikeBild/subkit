#!/usr/bin/env bash
# Terminology gate: fail the build if banned vocabulary leaks back into
# subkit source code.
#
# The banned-words list lives in scripts/terminology.banned.txt so the
# policy can evolve without editing shell logic. One term per line,
# word-boundary matched, case-insensitive.
#
# Permitted contexts (allow-list):
#  - tests/fixtures (we keep historic fixtures verbatim for replay)
#  - JSON/YAML data files and snapshot files
#  - self-healing/policy.ts explanatory comment about automation breadth
#  - this script itself (mentions the banned words by necessity)
#  - scripts/terminology.banned.txt (the policy itself)
#
# Carve-outs (intentionally NOT banned):
#  - "integration" / "integrations": kept permitted because users still
#    say "show my integrations" when they mean connectors. The
#    converse-pipeline intent-detector matches on the user utterance
#    (apps/engine/src/conversations/intent-detector.ts:43-58) so the
#    snapshot answer kicks in. Do not add `integration` to the banned
#    list without first updating the intent-detector to keep the user-
#    facing alias working.

set -euo pipefail

fail=0
BANNED_FILE="${BANNED_FILE:-scripts/terminology.banned.txt}"

# Banned-list file is optional — when absent, the gate runs only the
# OpenAPI-shape checks below (still meaningful) and otherwise short-circuits.
banned=()
if [ -f "$BANNED_FILE" ]; then
  while IFS= read -r line; do
    trimmed="${line#"${line%%[![:space:]]*}"}"   # ltrim
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}" # rtrim
    case "$trimmed" in
      ""|"#"*) continue ;;
    esac
    banned+=("$trimmed")
  done < "$BANNED_FILE"
fi

if [ "${#banned[@]}" -eq 0 ]; then
  echo "terminology gate: no banned terms configured (banned list empty or absent)"
else
  for word in "${banned[@]}"; do
    # Source trees we police. Docs/skills/seed markdown legitimately use
    # domain vocabulary when contrasting subkit with other categories — the
    # gate enforces TypeScript identifiers and generated API surfaces only.
    if grep -RniE "\\b${word}\\b" \
        apps/engine/src apps/sk/src packages \
        --include='*.ts' --include='*.tsx' \
        --exclude-dir=tests --exclude-dir=test --exclude-dir=__tests__ \
        --exclude-dir=fixtures --exclude-dir=node_modules \
        --exclude-dir=out --exclude-dir=dist --exclude-dir=seed \
        2>/dev/null | grep -vE '(self-healing/policy\.ts)' ; then
      echo "ERROR: banned term '${word}' still appears in engine/sk/packages TypeScript source" >&2
      fail=1
    fi
  done
fi

# Ticket-coupling guard: comments and docs must not reference PR
# numbers, issue IDs, bug labels, review waves, or roadmap phases.
# The git history owns ticket linkage; comments own invariants.
#
# Carve-out: apps/engine/.audit-loop-policy.md mentions a literal
# `issue #66` because that GitHub issue IS the audit-loop pause
# command (`/audit pause` on issue #66). Real operating procedure,
# not stale ticket coupling.
#
# `Wave[ -][A-Z]` catches review-wave letters from large-PR phasing in
# both the space-separated form (`Wave B Step 4`) and the hyphenated
# form (`Wave-D Step-6`). `Step[ -][0-9]+` catches the companion
# step-N markers used inside the same wave callouts. `Cross-cutting
# decision [A-Z][0-9]+` catches the plan-section decision IDs (e.g.
# `Cross-cutting decision D2`) that leak from review-plan docs into
# inline comments.
#
# Letter+digit shorthand codes (`C20`, `R10`, `D8`) from PR-review
# tables collide with widely-used pre-existing review identifiers
# (`R5-S5`, `R6-W2`, …) in identity / RBAC source if matched as bare
# `\b[CDR][0-9]+\b`. We instead ban them only when they appear in
# clearly review-coupled phrasings: parenthesized solo / parenthesized
# with descriptor / preceded by a connector word (`plan`, `described
# in`, `per`, `design`) / comma-then-space-then-code at a clause end.
# That hits the residual shapes the user keeps catching in review
# (`(D6)`, `(C4 hard rule)`, `, C15`, `plan D5`, `described in R8`)
# without flagging `R6-C1`, `Pass-2 C6`, `R2 etc.` (AWS S3, R2 storage),
# `H1`/`H2`/`H3` headers, and other legitimate identifiers.
ticket_pattern='(PR #[0-9]+|issue #[0-9]+|bug-[0-9]+|W[0-9]+ of (PR|round)|[SWPGR][0-9]+ of PR #[0-9]+|round [0-9]+ review|P0-[0-9]+|TODO\([^)]*[0-9]+\)|[A-Z]+[0-9]* closure of #[0-9]+|[A-Z][0-9]+ of #[0-9]+|of #[0-9]+ [A-Z][0-9]+|closure of #[0-9]+|(retired|landed|fixed|added) in #[0-9]+|as of #[0-9]+|(pre|post)-#[0-9]+|in PR #[0-9]+|Wave[ -][A-Z]\b|Step-[0-9]+\b|decision [A-Z][0-9]+\b|\([CDR][0-9]+\)|\([CDR][0-9]+ [a-z][^)]*\)|(plan|design|per the.*|described in|fallback chain.*in) [CDR][0-9]+\b|, [CDR][0-9]+(\)|\.))'
ticket_hits=$(grep -REn "$ticket_pattern" apps/ docs/ packages/ README.md \
    --include='*.ts' --include='*.tsx' --include='*.md' \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=tests \
    --exclude-dir=fixtures --exclude-dir=__tests__ --exclude-dir=out \
    --exclude-dir=seed --exclude=CHANGELOG.md 2>/dev/null \
    | grep -vE '\.audit-loop-policy\.md:[0-9]+:.*issue #66' || true)
if [ -n "$ticket_hits" ]; then
  echo "ERROR: ticket-coupling references found. Replace with present-tense invariants." >&2
  echo "$ticket_hits" >&2
  fail=1
fi

# OpenAPI-generated types must not carry the dead Automation schemas.
if grep -n 'Automation' packages/cli-core/src/engine-api/openapi.d.ts >/dev/null 2>&1; then
  echo "ERROR: packages/cli-core/src/engine-api/openapi.d.ts still contains 'Automation' — run 'bun run gen:openapi-client'" >&2
  fail=1
fi

# Legacy /v1/automations path must not reappear in generated openapi.
if grep -n '"/v1/automations' packages/cli-core/src/engine-api/openapi.json >/dev/null 2>&1; then
  echo "ERROR: /v1/automations path present in cli-core openapi.json" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "terminology gate failed" >&2
  exit 1
fi

echo "terminology gate: OK (${#banned[@]} term(s) enforced)"
