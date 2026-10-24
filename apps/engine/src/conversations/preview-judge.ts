import { createHash } from "node:crypto";
import { z } from "zod";
import type { Executor } from "../db/client.ts";
import { checkJsonSchemaContract } from "../execution/json-schema-contract.ts";
import { invoke } from "../llm/core/invoke.ts";
import { logger } from "../logging/logger.ts";
import {
  detectNamedOutputFormat,
  findFilterViolations,
  findMissingNamedFields,
  outputMatchesFormat,
} from "./output-format.ts";
import { canonicalJson } from "./text-line-diff.ts";
import { truncateForLlm, truncateStepPreviewForLlm } from "./tools/truncate.ts";

export const JUDGE_BREAKER_MAX_BLOCKS = 2;

export const JUDGE_BREAKER_ESCALATE_AFTER = 2;

const ARTIFACTS_TOTAL_BUDGET_CHARS = 6_000;
const FINAL_OUTPUT_BUDGET_CHARS = 3_000;

export const JudgeVerdictSchema = z.object({
  reason: z.string().min(1).max(800),
  missing: z.array(z.string().min(1).max(300)).max(12).default([]),
  verdict: z.enum(["passes", "partial", "failed"]),
});

export type PreviewJudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export type PreviewJudgeOutcome =
  | { verdict: "passes" | "partial" | "failed"; reason: string; missing: string[] }
  | { verdict: "skipped"; reason: "no_goal" | "judge_unavailable"; next_action?: string };

export interface JudgeStepArtifact {
  step_id: string;
  kind: string;
  status: string;
  output_preview?: unknown;
  held_request?: unknown;
}

export interface JudgeAcceptance {
  outputs: Array<{ name: string; description?: string | undefined }>;
  delivery: {
    channel: string;
    destination?: string | undefined;
    description?: string | undefined;
  } | null;
}

export interface JudgePreviewParams {
  goal: string;
  acceptance?: JudgeAcceptance | null;
  definition_summary: string;
  step_artifacts: JudgeStepArtifact[];
  final_output?: unknown;
  output_schema?: Record<string, unknown> | null;
  final_output_held?: boolean;
  tenant_id: string;
  db?: Executor;
  signal?: AbortSignal;
}

export function workflowDefinitionFingerprint(definition: unknown): string {
  return createHash("sha256").update(canonicalJson(definition)).digest("hex").slice(0, 16);
}

export function buildJudgeDefinitionSummary(steps: ReadonlyArray<Record<string, unknown>>): string {
  return steps
    .map((step) => {
      const id = typeof step.id === "string" ? step.id : "(no-id)";
      const kind = typeof step.kind === "string" ? step.kind : "unknown";
      const description =
        typeof step.description === "string" && step.description.length > 0
          ? `: ${step.description.slice(0, 160)}`
          : "";
      return `- ${id} (${kind})${description}`;
    })
    .join("\n");
}

interface JudgeSourceStep {
  step_key: string;
  kind: string;
  status: string;
  output_preview?: unknown;
  request_meta?: unknown;
}

function readHeldRequest(step: JudgeSourceStep): unknown {
  const top = (step as unknown as Record<string, unknown>).held_request;
  if (top !== undefined && top !== null) return top;
  const meta = step.request_meta;
  if (meta && typeof meta === "object") {
    const held = (meta as Record<string, unknown>).held_request;
    if (held !== undefined && held !== null) return held;
  }
  return undefined;
}

export function buildJudgeStepArtifacts(
  steps: ReadonlyArray<JudgeSourceStep>,
): JudgeStepArtifact[] {
  const eligible = steps.filter((s) => s.status !== "skipped");
  const prioritized = [...eligible].sort((a, b) => {
    const score = (s: JudgeSourceStep): number =>
      s.kind === "transform" ? 0 : readHeldRequest(s) !== undefined ? 1 : 2;
    return score(a) - score(b);
  });
  const byPriority: Array<{ artifact: JudgeStepArtifact; size: number }> = [];
  let total = 0;
  for (const step of prioritized) {
    const artifact: JudgeStepArtifact = {
      step_id: step.step_key,
      kind: step.kind,
      status: step.status,
    };
    if (step.output_preview !== undefined && step.output_preview !== null) {
      artifact.output_preview = truncateStepPreviewForLlm(step.output_preview).data;
    }
    const held = readHeldRequest(step);
    if (held !== undefined) {
      artifact.held_request = truncateStepPreviewForLlm(held).data;
    }
    let size: number;
    try {
      size = JSON.stringify(artifact)?.length ?? 0;
    } catch {
      continue;
    }
    if (total + size > ARTIFACTS_TOTAL_BUDGET_CHARS && byPriority.length > 0) continue;
    byPriority.push({ artifact, size });
    total += size;
  }
  const order = new Map(steps.map((s, i) => [s.step_key, i]));
  return byPriority
    .map((e) => e.artifact)
    .sort((a, b) => (order.get(a.step_id) ?? 0) - (order.get(b.step_id) ?? 0));
}

function renderArtifacts(artifacts: JudgeStepArtifact[]): string {
  try {
    return JSON.stringify(artifacts, null, 1) ?? "[]";
  } catch {
    return "(step artifacts not serialisable)";
  }
}

function renderJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 1) ?? "null";
  } catch {
    return "(not serialisable)";
  }
}

function hasFinalOutput(params: JudgePreviewParams): boolean {
  return params.final_output !== undefined && params.final_output !== null;
}

function renderFinalOutputSection(params: JudgePreviewParams): string[] {
  if (!hasFinalOutput(params)) return [];
  const bounded = truncateForLlm(params.final_output, FINAL_OUTPUT_BUDGET_CHARS, { store: false });
  return [
    "",
    "Final output the caller receives (after output_transform) — THIS is the object to judge. The step outputs above are only evidence of how it was produced:",
    "```json",
    renderJson(bounded.data),
    "```",
    ...(params.output_schema
      ? [
          "",
          "Declared output_schema the final output must satisfy:",
          "```json",
          renderJson(params.output_schema),
          "```",
        ]
      : []),
  ];
}

export function renderJudgeAcceptance(acceptance: JudgeAcceptance | null | undefined): string[] {
  if (!acceptance || (acceptance.outputs.length === 0 && !acceptance.delivery)) return [];
  const delivery = acceptance.delivery;
  return [
    "Acceptance criteria from the workflow's spec (part of the goal; judge the output against them):",
    ...acceptance.outputs.map(
      (field) => `- output \`${field.name}\`${field.description ? `: ${field.description}` : ""}`,
    ),
    ...(delivery
      ? [
          `- delivery via ${delivery.channel}${delivery.destination ? ` to ${delivery.destination}` : ""}${delivery.description ? `: ${delivery.description}` : ""}`,
        ]
      : []),
    "",
  ];
}

function buildJudgePrompt(params: JudgePreviewParams): string {
  return [
    "Judge whether a workflow's previewed output satisfies the user's goal.",
    "",
    "User goal (verbatim):",
    '"""',
    params.goal,
    '"""',
    "",
    ...renderJudgeAcceptance(params.acceptance),
    "Workflow definition (step ids, kinds, descriptions):",
    params.definition_summary,
    "",
    "Recorded step outputs from the preview. Transform steps carry the shaped result the user will see; `held_request` entries are fully-materialized outbound payloads that have NOT been sent yet. Every entry is truncated:",
    "```json",
    renderArtifacts(params.step_artifacts),
    "```",
    ...renderFinalOutputSection(params),
    "",
    "Verdict rules:",
    '- "passes": the output satisfies the goal. Minor cosmetic differences are fine — EXCEPT output format (see below).',
    '- "partial": the output mostly satisfies the goal, but something the goal explicitly asks for is missing or empty.',
    '- "failed": the output does not satisfy the goal.',
    '- `missing` lists each concrete item the goal asks for that is absent or empty in the output (e.g. "project names are empty strings", "droplet specs (CPU/memory/disk) absent"). Empty when the verdict is "passes".',
    "- Judge CONTENT, not cosmetic style. An empty value where the goal requires data is never a pass.",
    '- NAMED-FIELD COMPLETENESS: every field, column, or property the goal EXPLICITLY names must be present in the output. A table missing a column the goal listed, or an object missing a key the goal asked for, is at most "partial", never "passes" — list each absent named field in `missing`. Concretely: if the goal names four columns and the output table\'s header row carries only two of them, that is "partial" (the other two are missing) — do NOT pass it just because the rows present look well-formed. (Only judge fields the goal actually names; do not invent requirements. An EMPTY result set — zero data rows — is exempt: there is no data for the columns to carry.)',
    '- CRITERIA/FILTER CONSISTENCY: if the goal restricts the result to a subset (any "only X" / "where Y" / "by <whom>" / "in <category>" qualifier), the output must not contain items whose own values VISIBLY CONTRADICT that restriction — that means the filter was not applied → "failed". Concretely: if the goal asks only for items in a particular state and an output row plainly shows the OPPOSITE state, the filter was not applied → "failed", even if the table itself is well-formed. Judge only against restrictions the goal states and values visible in the output; an unverifiable count (the goal asks for N and fewer are shown, with no way to know how many exist) is NOT a violation on its own.',
    '- OUTPUT FORMAT IS PART OF THE GOAL when the goal names one. If the goal asks for "a markdown table", "CSV", "an HTML body", or "a bulleted list", the rendered output MUST be in that exact format (a markdown table needs a header row, a `| --- |` separator, and one row per record). Correct data returned in the wrong shape (e.g. a JSON array when a markdown table was asked for) is "partial", NOT "passes" — list the missing format in `missing`.',
    '- BUILD INSTRUCTIONS ARE NOT OUTPUT: parts of the goal that say HOW to build the workflow (step count or kinds, which expression language or definition field to use, "no separate transform step", "(not output_transform_function)", connector or endpoint choice, "preview it and save it") constrain the definition, not the output. Never list them in `missing` and never lower the verdict because the output does not mention them; judge only what the goal asks the output to contain.',
    '- RAW PAYLOAD IS NOT A RESULT: when the goal asks for a shaped or derived result (one value, a selection, a ranking, a summary, a composed message) and the final output is still the raw upstream payload (the full API response with its unselected arrays and metadata), the shaping never happened → "failed". A final output that only wraps the raw payload in a new key is the same failure.',
    "",
    "Return ONLY the JSON object { reason, missing, verdict }. Write the reason first and derive the verdict from it; a verdict that contradicts its own reason is invalid.",
  ].join("\n");
}

function coerceToString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function extractRenderedOutput(params: JudgePreviewParams): {
  rendered: string;
  source: "final_output" | "step_artifacts";
} {
  if (params.final_output !== undefined && params.final_output !== null) {
    return { rendered: coerceToString(params.final_output), source: "final_output" };
  }
  const last = params.step_artifacts[params.step_artifacts.length - 1];
  return { rendered: coerceToString(last?.output_preview), source: "step_artifacts" };
}

function outputSchemaMissing(params: JudgePreviewParams): string[] {
  if (!params.output_schema || params.final_output_held === true) return [];
  if (params.final_output === undefined) return [];
  const check = checkJsonSchemaContract(params.final_output, params.output_schema, "$output");
  if (!check.ok || check.valid) return [];
  return check.violations.map((v) => `${v.path}: ${v.message}`);
}

function coerceVerdict(raw: unknown): PreviewJudgeVerdict | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.verdict !== "passes" && obj.verdict !== "partial" && obj.verdict !== "failed") {
    return null;
  }
  const reasonRaw = typeof obj.reason === "string" ? obj.reason.trim() : "";
  const reason = (reasonRaw.length > 0 ? reasonRaw : "(judge gave no reason)").slice(0, 800);
  const missing = Array.isArray(obj.missing)
    ? obj.missing
        .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
        .map((m) => m.slice(0, 300))
        .slice(0, 12)
    : [];
  return { verdict: obj.verdict, reason, missing };
}

async function invokeJudgeOnce(prompt: string, params: JudgePreviewParams): Promise<unknown> {
  const result = await invoke(
    {
      flow: "judge",
      tenant_id: params.tenant_id,
      user_turns: [{ role: "user", content: prompt }],
      schema: JudgeVerdictSchema,
      ...(params.signal ? { signal: params.signal } : {}),
    },
    params.db,
  );
  return result.object;
}

export async function judgePreview(params: JudgePreviewParams): Promise<PreviewJudgeOutcome> {
  try {
    const prompt = buildJudgePrompt(params);
    let verdict = coerceVerdict(await invokeJudgeOnce(prompt, params));
    if (!verdict) {
      logger.info({
        module: "conversations",
        action: "judge.retry",
        msg: "preview judge returned no parseable {verdict} object — retrying once",
        tenant_id: params.tenant_id,
      });
      verdict = coerceVerdict(await invokeJudgeOnce(prompt, params));
    }
    if (!verdict) {
      throw new Error("preview judge returned no parseable verdict after one retry");
    }
    const schemaMissing = outputSchemaMissing(params);
    if (schemaMissing.length > 0 && verdict.verdict !== "failed") {
      logger.warn({
        module: "conversations",
        action: "preview_judge.schema_mismatch",
        msg: "final output does not satisfy the declared output_schema — verdict downgraded to partial",
        tenant_id: params.tenant_id,
        verdict: verdict.verdict,
        violations: schemaMissing,
      });
      return {
        verdict: "partial",
        reason: `The final output does not satisfy the declared output_schema: ${schemaMissing.join("; ")}`,
        missing: [...new Set([...verdict.missing, ...schemaMissing])].slice(0, 12),
      };
    }
    if (verdict.verdict === "passes") {
      const fmt = detectNamedOutputFormat(params.goal);
      if (fmt) {
        const { rendered, source } = extractRenderedOutput(params);
        const check = outputMatchesFormat(fmt, rendered);
        logger.info({
          module: "conversations",
          action: "preview_judge.format_check",
          msg: "goal names an output format — checked the final output for that format",
          tenant_id: params.tenant_id,
          named_format: fmt,
          checked_source: source,
          matched: check.ok,
          ...(check.ok ? {} : { failed_checks: check.missing }),
        });
        if (!check.ok) {
          logger.warn({
            module: "conversations",
            action: "preview_judge.format_mismatch",
            msg: "goal names an output format but the previewed output is not rendered as that format — verdict downgraded passes→partial",
            tenant_id: params.tenant_id,
            named_format: fmt,
            failed_checks: check.missing,
          });
          return {
            verdict: "partial",
            reason: `The goal asks for output as a ${fmt.replace("_", " ")}, but the previewed output is not rendered in that format.`,
            missing: check.missing,
          };
        }
      }
      const { rendered: renderedForFields } = extractRenderedOutput(params);
      const missingFields = findMissingNamedFields(params.goal, renderedForFields);
      if (missingFields.length > 0) {
        logger.warn({
          module: "conversations",
          action: "preview_judge.named_field_incomplete",
          msg: "goal enumerates fields/columns absent from the previewed output — verdict downgraded passes→partial",
          tenant_id: params.tenant_id,
          missing_fields: missingFields,
        });
        return {
          verdict: "partial",
          reason: `The goal asks for ${missingFields.join(", ")}, but ${missingFields.length === 1 ? "it is" : "they are"} absent from the previewed output.`,
          missing: missingFields,
        };
      }
      const violations = findFilterViolations(params.goal, renderedForFields);
      if (violations.length > 0) {
        logger.warn({
          module: "conversations",
          action: "preview_judge.filter_violation",
          msg: "goal excludes a value that appears in the previewed output — verdict downgraded passes→partial",
          tenant_id: params.tenant_id,
          violations,
        });
        return {
          verdict: "partial",
          reason: `The goal excludes ${violations.join(", ")}, but ${violations.length === 1 ? "that value appears" : "those values appear"} in the previewed output.`,
          missing: violations,
        };
      }
    }
    return {
      verdict: verdict.verdict,
      reason: verdict.reason,
      missing: verdict.missing,
    };
  } catch (err) {
    logger.warn({
      module: "conversations",
      action: "judge.unavailable",
      msg: "preview judge could not produce a verdict — skipping (commit proceeds)",
      tenant_id: params.tenant_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { verdict: "skipped", reason: "judge_unavailable" };
  }
}
