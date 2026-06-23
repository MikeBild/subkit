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
- `formatGuidance(fmt): string` — the focused per-format generation block (the
  "small output-format skill" content). Inlined into always-present generation
  grounding because the single-shot `author_workflow` generate flow renders
  skills only as the one-line INDEX: the context assembler body-renders solely
  `loaded_skill_slugs`, and generate has no tool loop to load any, so a skill's
  BODY (where this rule would otherwise live) never reaches generation — only
  its index entry does. (A controlled A/B later showed injecting the *full*
  skill body did not improve single-shot results either — the model already
  holds the rule-knowledge — so this stays a tight grounding line.)
- `outputMatchesFormat(fmt, rendered): { ok, missing }` — structural-signature
  check; the markdown signatures are byte-identical to the live benchmark's
  content checks so the contract is single-sourced.

Wired in two places:

1. **Generation grounding** — `authoring-pipeline.ts#buildGenerationPrompt`
   appends `formatGuidance(fmt)` when the goal names a format, and
   `runAuthoringPipeline` logs `authoring_pipeline.output_format_grounded`.
2. **Format-aware preview judge** — `preview-judge.ts#judgePreview`, on a
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

| Variant | trials | `content_pass` true | tool_calls | wall |
|---|---|---|---|---|
| OLD — generic one-line rule | 1 | 0/1 | 3 | ~53s |
| NEW — `formatGuidance` block | 3 (1 delta + 2 bench) | **0/3** | 2 | ~35–45s |

Raw-output inspection (`out/new.report.results.json`) on every NEW trial: the
`dry_run_workflow` final output carried **no** pipe-row and **no** separator —
i.e. not a markdown table.

**Verdict:** richer per-format generation guidance does **not** flip single-shot
output-format fidelity. The model consistently renders the table in an
intermediate step (or returns structured data) while the workflow's final
`output_transform` result — what the caller receives — is not the markdown
string. The grounding block is correct domain guidance and modestly more
efficient (2 vs 3 tool calls, faster), but it is **not** the fidelity fix.

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
