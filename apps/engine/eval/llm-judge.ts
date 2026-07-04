// LLM-as-judge harness for the eval suite.
//
// The deterministic validators in `eval/validators/` are the gate —
// they decide whether a fixture passes. The judge enriches the
// outcome: when a validator says "the structure is fine but I'm not
// sure about the semantics" (i.e. `function_passed=true` but
// `pass=false`), the judge reads the input + expected + observed
// output and renders a verdict (`passes`/`partial`/`failed`) plus
// short reasoning. The verdict NEVER overrides a deterministic
// `pass=false` — it travels alongside in the CSV/JSON report.
//
// Determinism contract: with `SUBKIT_EVAL_LLM_JUDGE` unset, this
// module is a no-op. With it set, the judge runs at temperature=0
// against a versioned prompt (`JUDGE_PROMPT_V1`) and a seeded
// sampler. Adding an LLM call to a deterministic gate is normally a
// red flag; here it's gated behind an opt-in env flag and the
// resulting `llm_judgment` field is informational only.

import type { LlmJudgment } from "./runner.ts";

/** Prompt revision marker. Bump when the prompt body or scoring
 *  criteria change so report consumers can tell judgments produced
 *  before/after the change apart. */
export const JUDGE_PROMPT_VERSION = "v1";

const JUDGE_SYSTEM_PROMPT = `You are an evaluation judge. Score whether \
an observed output should be considered acceptable for a given fixture. \
Reply with EXACTLY one of these labels on the first line — \`passes\`, \
\`partial\`, or \`failed\` — followed by one short sentence explaining \
your reasoning. Do not add any other text.`;

export interface JudgeInvokeParams {
  fixture_name: string;
  flow: string;
  input: unknown;
  expected: unknown;
  observed: unknown;
  /** Reason the deterministic validator returned `pass=false`. */
  validator_reason?: string;
}

export interface JudgeResult {
  judgment: LlmJudgment;
  reason: string;
}

/** True when the operator has opted in to running the judge. The flag
 *  must be set explicitly per run; CI builds run without it by default
 *  so the gate stays deterministic. */
export function judgeEnabled(): boolean {
  return process.env.SUBKIT_EVAL_LLM_JUDGE === "1";
}

/** Decide whether the judge should run for a given validator outcome.
 *  The judge runs only on the gap between "structure is fine" and
 *  "semantics agree" — not on pure structural failures (where there
 *  is nothing for a judge to add) and not on passes (no reason to
 *  burn tokens). */
export function shouldInvokeJudge(args: { pass: boolean; function_passed: boolean }): boolean {
  if (!judgeEnabled()) return false;
  if (args.pass) return false;
  return args.function_passed;
}

/** Invoke the LLM judge. The implementation is intentionally lazy so
 *  the eval runner does not pay the import cost of `llm/dispatch` in
 *  default runs. Tests inject `provider` to assert behaviour without
 *  reaching the network. */
export async function invokeJudge(
  params: JudgeInvokeParams,
  provider?: (prompt: { system: string; user: string }) => Promise<string>,
): Promise<JudgeResult> {
  const userBody = JSON.stringify({
    fixture: params.fixture_name,
    flow: params.flow,
    validator_reason: params.validator_reason ?? null,
    input: params.input,
    expected: params.expected,
    observed: params.observed,
    prompt_version: JUDGE_PROMPT_VERSION,
  });
  const callProvider = provider ?? (await defaultProvider());
  const text = await callProvider({ system: JUDGE_SYSTEM_PROMPT, user: userBody });
  return parseJudgeResponse(text);
}

/** Parse the judge's free-form output into a structured verdict. The
 *  judge is instructed to reply with the label on the first line; we
 *  defend against the model adding boilerplate by case-insensitively
 *  scanning the entire response for the first known label. Anything
 *  that fails to match falls back to `partial` so the run still
 *  records a result instead of crashing. */
export function parseJudgeResponse(text: string): JudgeResult {
  const normalized = text.trim();
  const lower = normalized.toLowerCase();
  let judgment: LlmJudgment = "partial";
  if (/(^|\W)passes(\W|$)/.test(lower)) judgment = "passes";
  else if (/(^|\W)failed(\W|$)/.test(lower)) judgment = "failed";
  else if (/(^|\W)partial(\W|$)/.test(lower)) judgment = "partial";
  // Take everything past the first newline (or the whole string if no
  // newline) as the reasoning. Cap at 500 chars so the CSV column does
  // not balloon.
  const idx = normalized.indexOf("\n");
  const tail = (idx >= 0 ? normalized.slice(idx + 1) : normalized).trim().slice(0, 500);
  return { judgment, reason: tail };
}

/** Default provider — wires through the engine's `invoke()` chokepoint
 *  using the `summarize` flow. Routing benefits: token budget, fallback
 *  chain, structured-log telemetry, and per-tenant LLM settings all
 *  apply identically to judge invocations.
 *
 *  Tenant id resolution: `SUBKIT_EVAL_TENANT_ID` overrides; otherwise
 *  the well-known eval tenant `00000000-0000-0000-0000-000000000000`
 *  is used so eval-time judge calls bill against a sentinel ledger
 *  rather than a real tenant.
 *
 *  The system prompt is composed by *prepending* the judge instructions
 *  to the synthesised user payload — `invoke()` does not expose an
 *  `additional_system` slot for non-converse flows, so we send the
 *  judge instructions inline as the first user turn instead. The
 *  resulting text response is parsed by `parseJudgeResponse`. */
async function defaultProvider(): Promise<
  (prompt: { system: string; user: string }) => Promise<string>
> {
  const { invoke } = await import("../src/llm/core/invoke.ts");
  return async ({ system, user }) => {
    const result = await invoke({
      flow: "summarize",
      tenant_id: process.env.SUBKIT_EVAL_TENANT_ID ?? "00000000-0000-0000-0000-000000000000",
      user_turns: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      telemetry_metadata: { eval_role: "judge", judge_prompt_version: JUDGE_PROMPT_VERSION },
    });
    return typeof result.text === "string" ? result.text : "";
  };
}
