import type { LlmJudgment } from "./runner.ts";

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
  validator_reason?: string;
}

export interface JudgeResult {
  judgment: LlmJudgment;
  reason: string;
}

export function judgeEnabled(): boolean {
  return process.env.SUBKIT_EVAL_LLM_JUDGE === "1";
}

export function shouldInvokeJudge(args: { pass: boolean; function_passed: boolean }): boolean {
  if (!judgeEnabled()) return false;
  if (args.pass) return false;
  return args.function_passed;
}

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

export function parseJudgeResponse(text: string): JudgeResult {
  const normalized = text.trim();
  const lower = normalized.toLowerCase();
  let judgment: LlmJudgment = "partial";
  if (/(^|\W)passes(\W|$)/.test(lower)) judgment = "passes";
  else if (/(^|\W)failed(\W|$)/.test(lower)) judgment = "failed";
  else if (/(^|\W)partial(\W|$)/.test(lower)) judgment = "partial";
  const idx = normalized.indexOf("\n");
  const tail = (idx >= 0 ? normalized.slice(idx + 1) : normalized).trim().slice(0, 500);
  return { judgment, reason: tail };
}

async function defaultProvider(): Promise<
  (prompt: { system: string; user: string }) => Promise<string>
> {
  const { invoke } = await import("../src/llm/runtime/invoke.ts");
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
