# Output-format fidelity — per-format grounding + format-aware judge

When a user's goal NAMES a concrete output format — "a markdown table", "CSV",
"an HTML body", "a bulleted list", "as JSON" — that format is part of the
contract, not a stylistic preference. Correct data in the wrong shape (a JSON
array where a markdown table was asked for) does not satisfy the goal.

## Mechanism (`apps/engine/src/conversations/output-format.ts`)

Two pure, deterministic, unit-tested helpers:

- `detectNamedOutputFormat(goal): NamedOutputFormat | null` — literal-phrase
  match on the goal's own wording (naming-gated; a plain-data goal returns
  `null`, so nothing below ever fires for it — no false blocks).
- `outputMatchesFormat(fmt, rendered): { ok, missing }` — structural-signature
  check; the markdown signatures are byte-identical to the live content checks
  so the contract is single-sourced.

The verified lever is the **format-aware preview judge**, and it is wired to the
run's resolved FINAL output — not an intermediate step artifact:

1. **Format-aware preview judge** — `preview-judge.ts#judgePreview`, on a
   `passes` verdict where the goal names a format, checks the rendered final
   output and downgrades `passes→partial` on a miss (logged as
   `preview_judge.format_check` / `preview_judge.format_mismatch`), routing
   through the existing block path so a wrong-format output is never silently
   auto-committed.

The judge evaluates the run's resolved final output (`RunResult.output`),
plumbed through `dry_run_workflow → runPreviewJudgeGate → judgePreview` (falling
back to the last step artifact only for a hold-writes preview); `format_check`
logs `checked_source: final_output | step_artifacts`. This matters because an
intermediate markdown step can be discarded by a later `output_transform` — the
caller receives structured data while the step artifact still "matches". The
deterministic proof is in `preview-judge.test.ts`: a markdown table in the step
artifact plus a structured (JSON-array) `final_output` now downgrades
`passes→partial`, whereas checking the step artifact would have passed; a
markdown-string `final_output` still passes even when the steps are structured.

`json` is intentionally included but is the degenerate case: a workflow's
structured output already serialises to JSON, so its guidance steers
`output_schema` + structured return rather than string rendering.

## Scope / non-goals

- Naming-gated: only acts when the goal explicitly names a format. No
  keyword-regex that *infers* format from intent (that would mistranslate).
- The judge guard is the verified safety net (blocks wrong-format auto-commit);
  whether single-shot generation emits the format first-try is stochastic and
  influenced, not guaranteed, by grounding.
- No env feature flags; format detection/matching lives as always-present
  grounding, not on-demand-loaded skills.
