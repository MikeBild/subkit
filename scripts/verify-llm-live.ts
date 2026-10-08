#!/usr/bin/env bun

import { generateText, jsonSchema, tool } from "ai";
import { GeneratedWorkflowSchema } from "../apps/engine/src/conversations/authoring-pipeline.ts";
import { JudgeVerdictSchema } from "../apps/engine/src/conversations/preview-judge.ts";
import { toInputExamples } from "../apps/engine/src/conversations/tools/sdk-wrap/invoke.ts";
import { AiSdkModel } from "../apps/engine/src/llm/core/ai-sdk-model.ts";
import { initializeModel, withToolInputExamples } from "../apps/engine/src/llm/core/model-init.ts";
import { zodToJsonSchema7 } from "../apps/engine/src/mcp/json-schema.ts";
import {
  exitCodeFor,
  LIVE_CHECK_NAMES,
  type LiveArgs,
  type LiveCheckName,
  type LiveCheckResult,
  orderedForFlow,
  parseLiveArgs,
  readKeyFile,
  redactDetail,
  renderTable,
} from "./llm-live-checks.ts";

interface LiveTarget {
  model: string;
  key: string;
  timeoutMs: number;
}

function liveModel(target: LiveTarget): AiSdkModel {
  return new AiSdkModel({
    providerOverride: "anthropic",
    apiKeyOverride: target.key,
    defaultModel: target.model,
    modelOverride: target.model,
    maxRetries: 0,
    callTimeoutMs: target.timeoutMs,
  });
}

const GENERATE_GOAL = [
  "Produce the SubKit workflow definition for this goal as the object the schema describes.",
  "Goal: fetch the user list from https://jsonplaceholder.typicode.com/users and return how many users there are.",
  'Use exactly two steps: first a request step with id "fetch_users" (kind "request", method "GET", url "https://jsonplaceholder.typicode.com/users"),',
  'then a transform step with id "count_users" (kind "transform", language "javascript", expression "return input.scope.fetch_users.data.length;").',
  'Use the slug "live-gate-user-count". Add no trigger and no schemas beyond what the goal needs.',
].join("\n");

async function checkGenerateWorkflow(target: LiveTarget): Promise<string> {
  const out = await liveModel(target).generateObject<unknown>({
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
  });
  if (!out.success) throw new Error(`structured generation failed: ${String(out.response)}`);
  const parsed = GeneratedWorkflowSchema.safeParse(out.response);
  if (!parsed.success) {
    throw new Error(
      `object does not parse as GeneratedWorkflowSchema: ${parsed.error.issues[0]?.message ?? "unknown issue"}`,
    );
  }
  if (parsed.data.steps.length !== 2) {
    throw new Error(`expected exactly 2 steps, got ${parsed.data.steps.length}`);
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
  const out = await liveModel(target).generateObject<unknown>({
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
  });
  if (!out.success) throw new Error(`structured judge call failed: ${String(out.response)}`);
  const parsed = JudgeVerdictSchema.safeParse(out.response);
  if (!parsed.success) {
    throw new Error(
      `object does not parse as JudgeVerdictSchema: ${parsed.error.issues[0]?.message ?? "unknown issue"}`,
    );
  }
  return `model_used=${out.model_used} verdict=${parsed.data.verdict}`;
}

async function checkToolInputExamples(target: LiveTarget): Promise<string> {
  const resolved = await initializeModel({
    providerOverride: "anthropic",
    apiKeyOverride: target.key,
    defaultModel: target.model,
    modelOverride: target.model,
  });
  const model = withToolInputExamples(resolved.model, resolved.provider, resolved.modelId);
  if (typeof model === "string") {
    throw new Error(`provider resolved to a gateway model id (${model}) instead of a model`);
  }
  const result = await generateText({
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
        ...toInputExamples({ name: "live-gate", ok: true }),
      }),
    },
    toolChoice: "required",
    maxRetries: 0,
    timeout: { totalMs: target.timeoutMs },
  });
  const body =
    typeof result.request.body === "string"
      ? result.request.body
      : JSON.stringify(result.request.body ?? null);
  if (!body.includes('"input_examples"')) {
    throw new Error("the request body sent to the provider carries no input_examples");
  }
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
      model: target.model,
      check,
      status: "PASS",
      ms: ms(),
      detail: redactDetail(detail, [target.key]),
    };
  } catch (err) {
    return {
      model: target.model,
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
      "usage: bun run verify:llm-live -- [--key-file <path>] [--models <a,b>] [--timeout-ms <ms>]",
    );
    return 2;
  }
  const key = readKeyFile(args.keyFile);
  if (key === null) {
    console.error(
      `verify:llm-live: no Anthropic key — ${args.keyFile} is missing or empty (pass --key-file <path>)`,
    );
    return exitCodeFor([], false);
  }
  const models = orderedForFlow(args.models, "generate");
  console.log(
    `verify:llm-live: ${models.length} model(s) × ${LIVE_CHECK_NAMES.length} checks, timeout ${args.timeoutMs} ms, key from ${args.keyFile}\n`,
  );
  const results: LiveCheckResult[] = [];
  for (const model of models) {
    const target: LiveTarget = { model, key, timeoutMs: args.timeoutMs };
    for (const check of LIVE_CHECK_NAMES) {
      const result = await runCheck(check, target);
      results.push(result);
      console.log(`${result.status} ${model} ${check} ${result.ms}ms ${result.detail}`);
    }
  }
  console.log(`\n${renderTable(results)}\n`);
  const code = exitCodeFor(results, true);
  console.log(code === 0 ? "verify:llm-live OK" : "verify:llm-live FAIL");
  return code;
}

process.exit(await main());
