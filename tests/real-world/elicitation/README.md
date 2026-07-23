# Real-world MCP elicitation matrix (operator diagnostic)

Drives **real MCP clients** (Claude Code, Codex CLI) in **real tmux sessions**
against a **locally booted sk engine** and verifies that native form
elicitation (`elicitation/create`) survives each client's actual rendering
behavior. Every cell saves terminal frames (`.txt`, `.ansi.txt`) and a PNG
screenshot to `shots/` and greps the engine log for the discriminator
actions, so a human can verify the run by eye afterwards.

This is an **operator diagnostic, not a CI gate**. It needs real client
binaries, a logged-in Claude Code / Codex, tmux, and a free port 3000. The
regression guarantee lives in the unit/integration suites
(`apps/engine/src/conversations/tests/pause-for-user-input-native.test.ts`,
`apps/engine/src/mcp/tests/conversation-native-elicitation.integration.test.ts`)
— this matrix exists to catch what only a real client can show.

## Why it exists

The engine once delivered elicitation forms by **blocking** the polling
`tools/call` on the client's answer with the SDK's 60s default timeout.
Real clients broke that in two different ways:

- **Claude Code** renders an MCP elicitation form only **after its own
  agent turn completes**. A blocked poll keeps the turn alive, so the form
  never rendered before the 60s timeout — every attempt ended in
  `elicitation_transport_failed`, and a late answer was silently dropped.
- **Codex** renders the form inline immediately, but a human answering in
  a terminal rarely beats 60s, and a late answer was silently dropped
  while the stale form stayed on screen.

The fix made delivery **non-blocking** (fire `elicitation/create`, return
`input_required` immediately, stage the answer in a detached continuation)
with a 5-minute round-trip timeout and a fast-cancel guard. This matrix
proves that behavior against the real clients.

## Prerequisites

- `tmux`, `python3` with PIL (for PNG rendering; falls back to text-only)
- `claude` (Claude Code ≥ 2.1.76) and/or `codex` (≥ 0.144), logged in
- Docker running with the repo's local Postgres (`docker compose up -d`)
- Port 3000 free; repo `.env` with `MASTER_KEY`

## Run

```bash
tests/real-world/elicitation/run-matrix.sh                 # all cells
tests/real-world/elicitation/run-matrix.sh claude-code     # one client
tests/real-world/elicitation/run-matrix.sh codex accept    # one cell
```

The engine is booted with `llm.provider=mock` (deterministic authoring
plan: a "list users" conversation always ends in an `ask_user_confirm`
commit gate) — the LLM is irrelevant here, the wire transport is the test
object. Ground truth is always the **engine log** (`shots/engine.log`),
never the client's narrated text.

## Matrix

| scenario  | drives                                     | expected engine log                                        |
|-----------|--------------------------------------------|------------------------------------------------------------|
| accept    | render form, answer it (deliberately >60s) | `mcp.elicitation.native_answer_staged` → `approval.approved` |
| timeout   | render form, never answer                  | poll returns `input_required` fast; NO `native_transport_failed` within the run window; row stays `pending` |
| cancel    | render form, cancel it after >2s           | answer staged with `user_cancelled` resume                 |

Client-side auto-cancel (a `cancel` <2s after send) and transport breaks
are covered by the engine's guards (`mcp.elicitation.form_fast_cancel`,
`mcp.elicitation.native_transport_failed`) — both leave the row pending
and retryable; they show up in the log grep if a client misbehaves.

## Output

`shots/<client>-<scenario>-<step>.{txt,ansi.txt,png}` plus
`shots/<client>-<scenario>.verdict` (PASS/FAIL + the proving log lines).
`shots/` is gitignored.

## Known client quirks (observed 2026-07)

- **Claude Code**: renders the form at end-of-turn. A *reused* interactive
  instance (after `/clear`, or after the engine restarted mid-session) may
  auto-cancel incoming elicitations within ~16ms; a fresh `claude` process
  behaves correctly. The harness always starts a fresh instance.
- **Codex**: `Enter` on an *empty* optional text field does not submit the
  form ("enter to submit all" needs at least one keystroke in the field or
  the field skipped via navigation). The harness types a reason before
  submitting. Codex re-renders a fresh form on every poll-triggered
  re-delivery; answer the newest one.
- **Codex config**: cells register a temporary `sklocal` server via
  `codex mcp add` and remove it afterwards. If a server named `sk`
  (production) exists, prompts must name `sklocal` explicitly — and a
  model may still pick `sk`; the verdict grep catches that (no calls in
  the local engine log = FAIL, re-run).
