#!/usr/bin/env bash
# PreToolUse hook for Bash in subkit.
#
# Contract:
#   - stdin is JSON from Claude Code ({"tool_input": {"command": "..."} , ...})
#   - exit 0 → ALLOW the command
#   - exit 2 → BLOCK the command; stderr is surfaced to Claude as the reason
#   - any other nonzero / unexpected error → treat as allow (don't break the session)
#
# Strategy:
#   - Split the command on clause separators (&& || ; |) so that unrelated
#     siblings don't cross-contaminate pattern checks (e.g. "ls .env; cat foo"
#     used to trigger the secret-reader rule because `cat` appeared somewhere
#     and `.env` appeared somewhere).
#   - For each clause, require the dangerous verb at the **start of the
#     clause** (after whitespace trim), followed by its args. This eliminates
#     cross-clause and echo/printf false positives while keeping the checks
#     simple.
#   - Known limitations (documented, accepted):
#       • `bash -c "cat .env"` / `env FOO=x cat .env` bypass the verb-at-start
#         anchor. A hook is not a sandbox.
#       • A dangerous flag literally embedded in a quoted string (e.g. `git
#         commit -m "explain --no-verify"`) will still trigger — regex cannot
#         cheaply discern quote state. Rephrase the message.
#     The hook is a safety net. The engine's RBAC, sandbox, and audit layers
#     own defense-in-depth.
#
# Meta-testing note: when testing this hook locally, remember the outer test
# command (`echo '{...}' | bash ...`) is itself a Bash tool invocation that
# fires this hook. With clause-splitting + verb-anchoring, most payloads are
# safe to embed in an echo now — the outer echo doesn't look like a reader
# verb to the hook.

set -u

cmd="$(cat 2>/dev/null | (command -v jq >/dev/null && jq -r '.tool_input.command // empty') 2>/dev/null || true)"
if [ -z "${cmd:-}" ]; then
  exit 0
fi

block() {
  echo "blocked by .claude/hooks/pre-bash-dispatch.sh: $1" >&2
  exit 2
}

# Split on clause separators: && || ; |   (order matters: try && and || before
# single & or |, so those two-char ops aren't partially consumed). We replace
# each separator with a newline, then iterate line-by-line — more portable
# across bash 3.2 (macOS default) than `read -a` with a custom IFS byte.
normalized="$(printf '%s' "$cmd" | sed -E 's/&&/\
/g; s/\|\|/\
/g; s/[;|]/\
/g')"

while IFS= read -r clause || [ -n "$clause" ]; do
  # Trim leading and trailing whitespace.
  clause="${clause#"${clause%%[![:space:]]*}"}"
  clause="${clause%"${clause##*[![:space:]]}"}"
  [ -z "$clause" ] && continue

  # --- Secrets: reader verb (at clause start) + .env/.pem/.key in this clause. ---
  if [[ "$clause" =~ ^(cat|less|more|head|tail|bat|nl|od|xxd)[[:space:]] ]]; then
    if [[ "$clause" =~ (^|[[:space:]/])\.env($|[[:space:]]|\.[a-zA-Z0-9_-]+) ]] \
      && ! [[ "$clause" =~ \.env\.(example|sample|template)($|[[:space:]/]) ]]; then
      block "reading .env* (other than .env.example/.sample/.template) is not allowed."
    fi
    if [[ "$clause" =~ (^|[[:space:]/])[^[:space:]]*\.(pem|key)($|[[:space:]]) ]]; then
      block "reading .pem / .key files is not allowed."
    fi
  fi

  # --- Raw openssl ---
  if [[ "$clause" =~ ^openssl[[:space:]] ]]; then
    block "running raw openssl is not allowed from an agent."
  fi

  # --- Destructive filesystem: rm on sensitive roots ---
  if [[ "$clause" =~ ^rm[[:space:]]+-[rfRF]+[[:space:]]+/([[:space:]]|$|\*) ]]; then
    block "rm -rf on / is not allowed."
  fi
  if [[ "$clause" =~ ^rm[[:space:]]+-[rfRF]+[[:space:]]+~($|[[:space:]/]) ]]; then
    block "rm -rf on home is not allowed."
  fi
  if [[ "$clause" =~ ^rm[[:space:]]+-[rfRF]+[[:space:]]+\.git($|[[:space:]]) ]]; then
    block "removing .git is not allowed."
  fi

  # --- Git safety: no force-push to main/master, no hook/signing skip. ---
  if [[ "$clause" =~ ^git[[:space:]]+push([[:space:]]|$) ]] \
    && [[ "$clause" =~ (--force([[:space:]]|$)|[[:space:]]-f([[:space:]]|$)) ]]; then
    # Force-with-lease to a non-main/master branch is fine.
    if [[ "$clause" =~ --force-with-lease ]] \
      && ! [[ "$clause" =~ origin[[:space:]]+(main|master)($|[[:space:]]) ]]; then
      : # allow
    else
      block "force-push is disabled (especially to main/master). Push to a feature branch or resolve the underlying issue."
    fi
  fi
  if [[ "$clause" =~ ^git[[:space:]] ]] \
    && [[ "$clause" =~ (^|[[:space:]])--no-verify($|[[:space:]]) ]]; then
    block "skipping commit hooks (--no-verify) is not allowed. Fix the hook failure root cause."
  fi
  if [[ "$clause" =~ ^git[[:space:]] ]] \
    && [[ "$clause" =~ (^|[[:space:]])--no-gpg-sign($|[[:space:]]) ]]; then
    block "bypassing commit signing is not allowed."
  fi

  # --- Production infra: prod compose profile. ---
  if [[ "$clause" =~ ^docker[-[:space:]]+compose[[:space:]] ]] \
    && [[ "$clause" =~ --profile[[:space:]]+prod($|[[:space:]]) ]]; then
    block "production docker compose profile is off-limits from agents. Run manually if intended."
  fi

  # --- Global installs: prefer workspace-local. ---
  if [[ "$clause" =~ ^(npm|bun|yarn|pnpm)[[:space:]]+(install|add|i)([[:space:]]|$) ]] \
    && [[ "$clause" =~ ([[:space:]])(-g|--global)($|[[:space:]]) ]]; then
    block "global installs are off-limits. Use workspace-local install or ask the user."
  fi
done <<EOF
$normalized
EOF

exit 0
