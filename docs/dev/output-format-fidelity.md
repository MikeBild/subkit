# Output-format fidelity — per-format generation grounding + format-aware judge

When a user's goal NAMES a concrete output format — "a markdown table", "CSV",
"an HTML body", "a bulleted list", "as JSON" — that format is part of the
contract, not a stylistic preference. Correct data in the wrong shape (a JSON
array where a markdown table was asked for) does not satisfy the goal.

This doc covers the mechanism and the **evidence experiment** behind the
thesis: *do small per-format "skills" (focused generation guidance) improve
authoring results?* See [`evidence-process.md`](./evidence-process.md) for the
methodology.

## Mechanism (`apps/engine/src/conversations/output-format.ts`)

Two pure, deterministic, unit-tested helpers + one guidance map:

- `detectNamedOutputFormat(goal): NamedOutputFormat | null` — literal-phrase
  match on the goal's own wording (naming-gated; a plain-data goal returns
  `null`, so nothing below ever fires for it — no false blocks).
- `outputMatchesFormat(fmt, rendered): { ok, missing }` — structural-signature
  check; the markdown signatures are byte-identical to the live benchmark's
  content checks so the contract is single-sourced.

> **Rolled back:** a `formatGuidance(fmt)` helper (a richer per-format
> generation block) once existed and was injected into `buildGenerationPrompt`.
> An A/B (below) showed it did not improve format fidelity over the one-line
> design rule + the final-output surfacing fix — the model already renders the
> format — so it was removed (no-overkill). What remains is a single design-rule
> line in `buildGenerationPrompt` plus the verified lever: the format-aware
> judge. (The single-shot generate flow renders skills only as the one-line
> INDEX — bodies render solely for `loaded_skill_slugs`, empty there — which is
> why a generation-prompt line, not a skill, carries the residual signal.)

Wired in one place (plus a cheap grounding line):

1. **Format-aware preview judge** — `preview-judge.ts#judgePreview`, on a
   `passes` verdict where the goal names a format, checks the rendered final
   output and downgrades `passes→partial` on a miss (logged as
   `preview_judge.format_check` / `preview_judge.format_mismatch`), routing
   through the existing block path so a wrong-format output is never silently
   auto-committed.

`json` is intentionally included but is the degenerate case: a workflow's
structured output already serialises to JSON, so its guidance steers
`output_schema` + structured return rather than string rendering.

## The evidence experiment

**Thesis:** richer per-format guidance (`formatGuidance`) produces the named
format as the FINAL output more reliably than the generic one-line design rule.

**A/B method** (two git states, no feature flag). The local benchmark wrapper
(`benchmarks/authoring/`, gitignored) automates the engine boots:

```
# OLD = HEAD (generic one-line rule). NEW = working tree (formatGuidance block).
BENCH_OLD_REF=HEAD BENCH_SCENARIOS=weather-ranking-table ./benchmarks/authoring/run.sh delta
```

The committed equivalent (no wrapper) is `bun run eval:live … --out b.json
--baseline a.json` against two engine builds — see
[`evidence-process.md`](./evidence-process.md).

Metric: `first_preview_content_pass` (does the actual `dry_run_workflow` output
contain the format's structural signature). Inspect the raw output in the
sibling `*.results.json` to confirm a pass/fail is real, not a measurement
artifact.

Because generation is stochastic, a single A/B run is weak evidence — run
several trials and look at the rate, not one outcome.

### Findings (`weather-ranking-table` scenario, open-meteo, Sonnet 4.6)

This experiment ran TWICE — and the first run was a cautionary tale in measuring
the wrong thing:

- **First run (INVALID):** scored `content_pass` off the whole preview envelope
  while `formatGuidance` was present → an early `0/3` that *looked* like a clean
  refutation. It was a measurement artifact: the metric scored the whole
  envelope (step traces, definition echo), and separately the `dry_run` preview
  surfaced the LAST STEP, not the resolved final output — so the markdown the
  workflow actually produced was invisible. (Both gaps are now fixed: per-scenario
  `content_source:"final_output"` scoring + the final-output surfacing fix.)
- **Clean A/B (valid):** `formatGuidance` ON (OLD) vs OFF (NEW), markdown
  scenario, fixed metric. Clean trials (excluding one key-extraction flake):
  OLD `content_pass` **3/3 true** = NEW **3/3 true**, single preview each.
  **No difference.**

**Verdict:** `formatGuidance` does not change output-format fidelity — removing
it leaves `content_pass` at 3/3. The model already renders the named format; the
real fix was surfacing the FINAL output to the judge + preview (so it is no
longer hidden behind the last step), not more generation prose. `formatGuidance`
was therefore **rolled back** (no-overkill); a one-line design rule remains.

**The effective lever is the preview judge, not generation grounding — and it
is now wired to the FINAL output.** The judge previously evaluated
`step_artifacts`, so an intermediate markdown step gave `format_check
matched:true → passes` even when a later `output_transform` discarded it and the
caller received structured data. The fix plumbs the run's resolved final output
(`RunResult.output`) through `dry_run_workflow → runPreviewJudgeGate →
judgePreview`; the format check evaluates that (falling back to the last step
artifact only for a hold-writes preview), and `format_check` logs
`checked_source: final_output | step_artifacts`.

Proof (deterministic, the clean A/B for this fix — `preview-judge.test.ts`):
identical inputs — a markdown table in the step artifact + a structured
(JSON-array) `final_output` — now downgrade `passes→partial` (checks
`final_output`), whereas checking the step artifact would have passed. A
markdown-string `final_output` still passes even when the steps are structured.
A live run confirms `checked_source: final_output`.

The live content benchmark is NOT a clean A/B vehicle for this fix: the
`dry_run_workflow` tool's `preview` field still surfaces the *last step*, not
`RunResult.output`, so the benchmark's content check (and the chat preview a
user sees) measures the wrong corpus. Aligning the dry-run preview with the
final output is a separate, bounded follow-up.

**Breadth:** only `markdown_table` (the hardest string-rendered case) was
trialed; `json` is the degenerate default (structured output already serialises
to JSON). Adding `csv`/`html` scenarios would test generality — but the
markdown result is the strongest available signal and it is unambiguous.

**So: are small per-format skills worth it?** As a *generation* lever, the
evidence says no (0/3). They earn their place as (a) correct, unit-tested
domain guidance with a small efficiency gain, and (b) the shared
detector/matcher that the judge-side fix will reuse. Format fidelity is won at
the *judge*, on the final output — not by adding more generation prompt.

## Scope / non-goals

- Naming-gated: only acts when the goal explicitly names a format. No
  keyword-regex that *infers* format from intent (that would mistranslate).
- The judge guard is the verified safety net (blocks wrong-format auto-commit);
  whether single-shot generation emits the format first-try is stochastic and
  influenced, not guaranteed, by grounding.
- No env feature flags; format skills live as always-present grounding, not
  on-demand-loaded skills.
