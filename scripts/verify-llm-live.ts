#!/usr/bin/env bun

import { generateText, jsonSchema, tool } from "ai";
import type { ZodIssue } from "zod";
import { GeneratedWorkflowSchema } from "../apps/engine/src/conversations/authoring-pipeline.ts";
import { JudgeVerdictSchema } from "../apps/engine/src/conversations/preview-judge.ts";
import { toInputExamples } from "../apps/engine/src/conversations/tools/sdk-wrap/invoke.ts";
import { AiSdkModel } from "../apps/engine/src/llm/runtime/ai-sdk-model.ts";
import {
  initializeModel,
  withToolInputExamples,
} from "../apps/engine/src/llm/runtime/model-init.ts";
import { zodToJsonSchema7 } from "../apps/engine/src/mcp/json-schema.ts";
import {
  assertLiveInputBound,
  assertLiveToolEvidence,
  exitCodeFor,
  LIVE_CHECK_NAMES,
  LIVE_OUTPUT_TOKEN_LIMITS,
  LIVE_TOOL_EXAMPLE,
  type LiveArgs,
  type LiveCheckName,
  type LiveCheckResult,
  type LiveProvider,
  orderedForFlow,
  parseLiveArgs,
  parseModelRef,
  readKeyFile,
  redactDetail,
  renderTable,
} from "./llm-live-checks.ts";

interface LiveTarget {
  label: string;
  provider: LiveProvider;
  model: string;
  key: string;
  timeoutMs: number;
}

function trackedGenerateText(target: LiveTarget, check: LiveCheckName): typeof generateText {
  return (async (...args: Parameters<typeof generateText>) => {
    const options = args[0];
    const format = options.output ? await options.output.responseFormat : undefined;
    const inputBytes = assertLiveInputBound({
      messages: options.messages,
      tools: options.tools,
      output: format,
    });
    if (options.maxRetries !== 0 || options.maxOutputTokens !== LIVE_OUTPUT_TOKEN_LIMITS[check]) {
      throw new Error("live gate request does not enforce its retry and output limits");
    }
    console.log(
      `verify:llm-live:request ${JSON.stringify({
        model: target.label,
        check,
        input_bytes: inputBytes,
        max_requests: check === "tool_input_examples" ? 1 : 2,
        max_output_tokens_per_request: LIVE_OUTPUT_TOKEN_LIMITS[check],
      })}`,
    );
    const result = await generateText(...args);
    console.log(
      `verify:llm-live:usage ${JSON.stringify({
        model: target.label,
        check,
        input_bytes: inputBytes,
        requests: result.steps.length,
        max_requests: check === "tool_input_examples" ? 1 : 2,
        max_output_tokens_per_request: LIVE_OUTPUT_TOKEN_LIMITS[check],
        input_tokens: result.totalUsage.inputTokens ?? null,
        output_tokens: result.totalUsage.outputTokens ?? null,
      })}`,
    );
    return result;
  }) as typeof generateText;
}

function liveModel(target: LiveTarget, check: LiveCheckName): AiSdkModel {
  return new AiSdkModel({
    providerOverride: target.provider,
    apiKeyOverride: target.key,
    defaultModel: target.model,
    modelOverride: target.model,
    maxRetries: 0,
    callTimeoutMs: target.timeoutMs,
    generateTextFn: trackedGenerateText(target, check),
  });
}

const LIVE_WORKFLOW_NAME = "User count";
const LIVE_WORKFLOW_SLUG = "live-gate-user-count";

const GENERATE_GOAL = [
  "Produce the SubKit workflow definition for this goal as the object the schema describes.",
  `Return a flat top-level object with name ${JSON.stringify(LIVE_WORKFLOW_NAME)}, slug exactly ${JSON.stringify(LIVE_WORKFLOW_SLUG)}, and steps. Do not wrap it in a workflow or definition object.`,
  "Goal: fetch the user list from https://jsonplaceholder.typicode.com/users and return how many users there are.",
  'Use exactly two steps: first a request step with id "fetch_users" (kind "request", method "GET", url "https://jsonplaceholder.typicode.com/users"),',
  'then a transform step with id "count_users" (kind "transform", language "javascript", expression "return input.scope.fetch_users.data.length;").',
  "Add no trigger and no schemas beyond what the goal needs.",
].join("\n");

function describeSchemaIssues(issues: ZodIssue[]): string {
  return issues
    .slice(0, 3)
    .map(
      (issue) =>
        `${issue.path.length > 0 ? issue.path.join(".") : "<root>"} [${issue.code}]: ${issue.message}`,
    )
    .join("; ");
}

async function checkGenerateWorkflow(target: LiveTarget): Promise<string> {
  const out = await liveModel(target, "generate_workflow").generateObject<unknown>({
    messages: [
      {
        role: "system",
        content:
          "You author SubKit workflow definitions. Answer only with the object the schema asks for.",
      },
      { role: "user", content: GENERATE_GOAL },
    ],
    schema: zodToJsonSchema7(GeneratedWorkflowSchema),
    maxAttempts: 2,
    maxOutputTokens: LIVE_OUTPUT_TOKEN_LIMITS.generate_workflow,
  });
  if (!out.success) throw new Error(`structured generation failed: ${String(out.response)}`);
  const parsed = GeneratedWorkflowSchema.safeParse(out.response);
  if (!parsed.success) {
    throw new Error(
      `object does not parse as GeneratedWorkflowSchema: ${describeSchemaIssues(parsed.error.issues)}`,
    );
  }
  if (parsed.data.steps.length !== 2) {
    throw new Error(`expected exactly 2 steps, got ${parsed.data.steps.length}`);
  }
  if (parsed.data.name !== LIVE_WORKFLOW_NAME) {
    throw new Error(`expected workflow name ${JSON.stringify(LIVE_WORKFLOW_NAME)}`);
  }
  if (parsed.data.slug !== LIVE_WORKFLOW_SLUG) {
    throw new Error(`expected workflow slug ${JSON.stringify(LIVE_WORKFLOW_SLUG)}`);
  }
  return `model_used=${out.model_used} steps=2 output_tokens=${out.usage.output_tokens}`;
}

const JUDGE_CASE = [
  "Goal: return the number of users in the directory.",
  "Final output the caller receives (after output_transform): 10",
  "Step artifacts: fetch_users (request, succeeded, 10 records); count_users (transform, succeeded).",
  "Judge whether the final output satisfies the goal.",
].join("\n");

async function checkJudgeVerdict(target: LiveTarget): Promise<string> {
  const out = await liveModel(target, "judge_verdict").generateObject<unknown>({
    messages: [
      {
        role: "system",
        content:
          "You judge whether a workflow preview satisfies its goal. Answer only with the verdict object.",
      },
      { role: "user", content: JUDGE_CASE },
    ],
    schema: zodToJsonSchema7(JudgeVerdictSchema),
    maxAttempts: 2,
    maxOutputTokens: LIVE_OUTPUT_TOKEN_LIMITS.judge_verdict,
  });
  if (!out.success) throw new Error(`structured judge call failed: ${String(out.response)}`);
  const parsed = JudgeVerdictSchema.safeParse(out.response);
  if (!parsed.success) {
    throw new Error(
      `object does not parse as JudgeVerdictSchema: ${describeSchemaIssues(parsed.error.issues)}`,
    );
  }
  return `model_used=${out.model_used} verdict=${parsed.data.verdict}`;
}

async function checkToolInputExamples(target: LiveTarget): Promise<string> {
  const resolved = await initializeModel({
    providerOverride: target.provider,
    apiKeyOverride: target.key,
    defaultModel: target.model,
    modelOverride: target.model,
  });
  const model = withToolInputExamples(resolved.model, resolved.provider, resolved.modelId);
  if (typeof model === "string") {
    throw new Error(`provider resolved to a gateway model id (${model}) instead of a model`);
  }
  const result = await trackedGenerateText(
    target,
    "tool_input_examples",
  )({
    model,
    messages: [
      {
        role: "user",
        content: 'Record the live gate check: call record_check with name "live-gate" and ok true.',
      },
    ],
    tools: {
      record_check: tool({
        description: "Records the outcome of a check.",
        inputSchema: jsonSchema<Record<string, unknown>>({
          type: "object",
          properties: { name: { type: "string" }, ok: { type: "boolean" } },
          required: ["name", "ok"],
          additionalProperties: false,
        }),
        ...toInputExamples(LIVE_TOOL_EXAMPLE),
      }),
    },
    toolChoice: "required",
    include: { requestBody: true },
    maxRetries: 0,
    maxOutputTokens: LIVE_OUTPUT_TOKEN_LIMITS.tool_input_examples,
    timeout: { totalMs: target.timeoutMs },
  });
  assertLiveToolEvidence(target.provider, result.request.body, result.toolCalls);
  const first = result.toolCalls[0];
  return `finish=${result.finishReason} tool_calls=${result.toolCalls.length}${first ? ` first=${first.toolName}` : ""}`;
}

const CHECKS: Record<LiveCheckName, (target: LiveTarget) => Promise<string>> = {
  generate_workflow: checkGenerateWorkflow,
  judge_verdict: checkJudgeVerdict,
  tool_input_examples: checkToolInputExamples,
};

async function runCheck(check: LiveCheckName, target: LiveTarget): Promise<LiveCheckResult> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const detail = await CHECKS[check](target);
    return {
      model: target.label,
      check,
      status: "PASS",
      ms: ms(),
      detail: redactDetail(detail, [target.key]),
    };
  } catch (err) {
    return {
      model: target.label,
      check,
      status: "FAIL",
      ms: ms(),
      detail: redactDetail(err instanceof Error ? err.message : String(err), [target.key]),
    };
  }
}

async function main(): Promise<number> {
  let args: LiveArgs;
  try {
    args = parseLiveArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`verify:llm-live: ${err instanceof Error ? err.message : String(err)}\n`);
    console.error(
      "usage: bun run verify:llm-live -- [--key-file <path>] [--openai-key-file <path>] [--models <[provider:]model,…>] [--timeout-ms <ms>]",
    );
    return 2;
  }
  const models = orderedForFlow(args.models, "generate");
  const keyFiles: Record<LiveProvider, string> = {
    anthropic: args.keyFile,
    openai: args.openaiKeyFile,
  };
  const keys: Partial<Record<LiveProvider, string>> = {};
  for (const provider of new Set(models.map((m) => parseModelRef(m).provider))) {
    const key = readKeyFile(keyFiles[provider]);
    if (key === null) {
      console.error(
        `verify:llm-live: no ${provider} key — ${keyFiles[provider]} is missing or empty (pass --${provider === "anthropic" ? "key-file" : "openai-key-file"} <path>)`,
      );
      return exitCodeFor([], false);
    }
    keys[provider] = key;
  }
  console.log(
    `verify:llm-live: ${models.length} model(s) × ${LIVE_CHECK_NAMES.length} checks, timeout ${args.timeoutMs} ms, providers ${Object.keys(keys).join(",")}\n`,
  );
  const results: LiveCheckResult[] = [];
  for (const label of models) {
    const ref = parseModelRef(label);
    const target: LiveTarget = {
      label,
      provider: ref.provider,
      model: ref.model,
      key: keys[ref.provider] as string,
      timeoutMs: args.timeoutMs,
    };
    for (const check of LIVE_CHECK_NAMES) {
      const result = await runCheck(check, target);
      results.push(result);
      console.log(`${result.status} ${label} ${check} ${result.ms}ms ${result.detail}`);
    }
  }
  console.log(`\n${renderTable(results)}\n`);
  const code = exitCodeFor(results, true);
  console.log(code === 0 ? "verify:llm-live OK" : "verify:llm-live FAIL");
  return code;
}

process.exit(await main());
