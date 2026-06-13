import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { type EvalBindings, evaluate as evaluateJsonata } from "../src/execution/jsonata-engine.ts";
import { runJs } from "../src/sandboxes/quickjs/runtime.ts";

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const EstateReplayCaseSchema = z.object({
  id: z.string().min(1),
  workflow_id: z.string().optional(),
  workflow_slug: z.string().optional(),
  transform_id: z.string().optional(),
  kind: z.enum(["step_transform", "output_transform"]),
  old_jsonata: z.object({
    expression: z.string(),
    data: JsonValueSchema.optional(),
    bindings: JsonValueSchema.optional(),
  }),
  new_javascript: z.object({
    code: z.string(),
    input: JsonValueSchema.optional(),
  }),
  side_effects: z
    .object({
      old_held_requests: z.array(JsonValueSchema).default([]),
      new_held_requests: z.array(JsonValueSchema).default([]),
    })
    .optional(),
});

export const EstateReplayManifestSchema = z.object({
  manifest_version: z.literal(1),
  generated_at: z.string().optional(),
  tenant_id: z.string().optional(),
  description: z.string().optional(),
  cases: z.array(EstateReplayCaseSchema).min(1),
});

export type EstateReplayCase = z.infer<typeof EstateReplayCaseSchema>;
export type EstateReplayManifest = z.infer<typeof EstateReplayManifestSchema>;

export interface EstateReplayCaseResult {
  id: string;
  workflow_id?: string;
  workflow_slug?: string;
  transform_id?: string;
  kind: EstateReplayCase["kind"];
  old_hash: string;
  new_hash: string;
  output_equal: boolean;
  side_effects_equal: boolean | null;
  passed: boolean;
  old_output: unknown;
  new_output: unknown;
  error?: string;
}

export interface EstateReplayReport {
  total: number;
  passed: number;
  failed: number;
  cases: EstateReplayCaseResult[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asBindings(value: unknown): EvalBindings {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as EvalBindings)
    : {};
}

export async function replayEstateCase(
  testCase: EstateReplayCase,
): Promise<EstateReplayCaseResult> {
  const base = {
    id: testCase.id,
    ...(testCase.workflow_id ? { workflow_id: testCase.workflow_id } : {}),
    ...(testCase.workflow_slug ? { workflow_slug: testCase.workflow_slug } : {}),
    ...(testCase.transform_id ? { transform_id: testCase.transform_id } : {}),
    kind: testCase.kind,
    old_hash: sha256(testCase.old_jsonata.expression),
    new_hash: sha256(testCase.new_javascript.code),
  };
  try {
    const old_output = await evaluateJsonata(
      testCase.old_jsonata.expression,
      testCase.old_jsonata.data ?? null,
      asBindings(testCase.old_jsonata.bindings),
    );
    const newResult = await runJs({
      code: testCase.new_javascript.code,
      input: testCase.new_javascript.input ?? null,
    });
    const new_output = newResult.output;
    const output_equal = isDeepStrictEqual(old_output, new_output);
    const side_effects_equal = testCase.side_effects
      ? isDeepStrictEqual(
          testCase.side_effects.old_held_requests,
          testCase.side_effects.new_held_requests,
        )
      : null;
    return {
      ...base,
      output_equal,
      side_effects_equal,
      passed: output_equal && side_effects_equal !== false,
      old_output,
      new_output,
    };
  } catch (err) {
    return {
      ...base,
      output_equal: false,
      side_effects_equal: null,
      passed: false,
      old_output: null,
      new_output: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function replayEstateManifest(
  manifest: EstateReplayManifest,
): Promise<EstateReplayReport> {
  const cases = [];
  for (const testCase of manifest.cases) {
    cases.push(await replayEstateCase(testCase));
  }
  const passed = cases.filter((result) => result.passed).length;
  return { total: cases.length, passed, failed: cases.length - passed, cases };
}
