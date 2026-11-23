import { MODEL_STEP_MAX_OUTPUT_TOKENS } from "../types.ts";

export type ModelStepRewriteSkipReason =
  | "not_one_user_message"
  | "no_output_schema"
  | "output_referenced"
  | "request_only_fields";

export interface ModelStepRewriteChange {
  step_id: string;
}

export interface ModelStepRewriteSkip {
  step_id: string;
  reason: ModelStepRewriteSkipReason;
}

export interface StoredModelStepRewrite {
  changed: boolean;
  dag: unknown;
  changes: ModelStepRewriteChange[];
  skipped: ModelStepRewriteSkip[];
}

type Dialect = "messages" | "chat" | "responses";

const PROVIDER_HOSTS = new Set([
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "gateway.ai.cloudflare.com",
  "ai-gateway.vercel.sh",
]);
const PROVIDER_PLACEHOLDER = /^\$\{connector\.(anthropic|openai)\.base_url\}/;
const ROOT_REFERENCE_FIELDS = [
  "output_transform",
  "output_transform_function",
  "validation_function",
];
const REQUEST_ONLY_FIELDS = [
  "data_selector",
  "response_filters",
  "outputs",
  "state_read",
  "state_write",
  "multipart",
  "pagination",
];
const KEPT_FIELDS = ["on_error", "timeout_ms", "for_each", "for_each_concurrency"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function providerTarget(url: unknown): boolean {
  if (typeof url !== "string") return false;
  if (PROVIDER_PLACEHOLDER.test(url)) return true;
  try {
    return PROVIDER_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function dialectOf(step: Record<string, unknown>): Dialect | null {
  if (step.kind !== "request" || step.method !== "POST" || !providerTarget(step.url)) return null;
  const path = (step.url as string).split("?")[0] ?? "";
  if (path.endsWith("/messages")) return "messages";
  if (path.endsWith("/chat/completions")) return "chat";
  if (path.endsWith("/responses")) return "responses";
  return null;
}

function schemaAt(value: unknown, path: string[]): Record<string, unknown> | undefined {
  let cur: unknown = value;
  for (const key of path) cur = isRecord(cur) ? cur[key] : undefined;
  return isRecord(cur) ? cur : undefined;
}

function outputSchema(body: Record<string, unknown>): Record<string, unknown> | undefined {
  return (
    schemaAt(body, ["output_config", "format", "schema"]) ??
    schemaAt(body, ["response_format", "json_schema", "schema"]) ??
    schemaAt(body, ["text", "format", "schema"])
  );
}

function conversation(
  dialect: Dialect,
  body: Record<string, unknown>,
): { prompt: string; system?: string } | null {
  if (dialect === "responses") {
    const prompt = str(body.input);
    const system = str(body.instructions);
    return prompt ? { prompt, ...(system ? { system } : {}) } : null;
  }
  const messages = Array.isArray(body.messages) ? body.messages.filter(isRecord) : [];
  const users = messages.filter((m) => m.role === "user");
  const systems = messages.filter((m) => m.role === "system").map((m) => str(m.content));
  const prompt = users.length === 1 ? str(users[0]?.content) : undefined;
  if (!prompt || messages.length !== users.length + systems.length) return null;
  if (systems.some((s) => s === undefined)) return null;
  const system = [str(body.system), ...systems].filter((s): s is string => s !== undefined);
  return { prompt, ...(system.length > 0 ? { system: system.join("\n\n") } : {}) };
}

function maxOutputTokens(body: Record<string, unknown>): number | undefined {
  const raw = [body.max_tokens, body.max_completion_tokens, body.max_output_tokens].find(
    (v) => typeof v === "number" && Number.isInteger(v) && v > 0,
  ) as number | undefined;
  return raw === undefined ? undefined : Math.min(raw, MODEL_STEP_MAX_OUTPUT_TOKENS);
}

function outputReferenced(dag: Record<string, unknown>, steps: unknown[], id: string): boolean {
  const byStep = steps.some(
    (step) => isRecord(step) && step.id !== id && JSON.stringify(step).includes(id),
  );
  if (byStep) return true;
  const haystack = [
    ...ROOT_REFERENCE_FIELDS.map((field) => dag[field]),
    dag.output_schema === undefined ? undefined : JSON.stringify(dag.output_schema),
  ].filter((value): value is string => typeof value === "string");
  return haystack.some((text) => text.includes(id));
}

export function rewriteStoredModelSteps(dag: unknown): StoredModelStepRewrite {
  const steps = isRecord(dag) && Array.isArray(dag.steps) ? dag.steps : null;
  if (!isRecord(dag) || !steps) return { changed: false, dag, changes: [], skipped: [] };
  const changes: ModelStepRewriteChange[] = [];
  const skipped: ModelStepRewriteSkip[] = [];
  const out = steps.map((step: unknown) => {
    if (!isRecord(step) || typeof step.id !== "string") return step;
    const dialect = dialectOf(step);
    if (!dialect) return step;
    const skip = (reason: ModelStepRewriteSkipReason) => {
      skipped.push({ step_id: step.id as string, reason });
      return step;
    };
    const body = isRecord(step.body) ? step.body : {};
    if (REQUEST_ONLY_FIELDS.some((field) => step[field] !== undefined))
      return skip("request_only_fields");
    const talk = conversation(dialect, body);
    if (!talk) return skip("not_one_user_message");
    const schema = outputSchema(body);
    if (!schema) return skip("no_output_schema");
    if (outputReferenced(dag, steps, step.id)) return skip("output_referenced");
    const limit = maxOutputTokens(body);
    changes.push({ step_id: step.id });
    return {
      kind: "model",
      id: step.id,
      ...Object.fromEntries(
        KEPT_FIELDS.flatMap((f) => (step[f] === undefined ? [] : [[f, step[f]]])),
      ),
      prompt: talk.prompt,
      ...(talk.system ? { system: talk.system } : {}),
      output_schema: schema,
      ...(limit !== undefined ? { max_output_tokens: limit } : {}),
    };
  });
  if (changes.length === 0) return { changed: false, dag, changes, skipped };
  return { changed: true, dag: { ...dag, steps: out }, changes, skipped };
}
