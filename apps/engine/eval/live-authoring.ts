import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { canaryVerdict, MAX_ATTEMPTS, withFaultRetry } from "./faults.ts";
import { gateStatus, recordProofs } from "./gate.ts";
import { liveFingerprints, provenOn, readGate, writeGate } from "./gate-store.ts";
import { compareLiveAuthoringReports } from "./live-benchmark.ts";
import {
  ASK_TOOLS,
  aggregateTrials,
  bindScenarioInputs,
  buildLiveReport,
  CANARY_SPEC,
  type CreatedArtifact,
  collectCreatedArtifacts,
  deletionOrder,
  EVAL_LIVE_TITLE_PREFIX,
  LIVE_SCENARIOS,
  type LiveAuthoringReport,
  type LiveRunSpec,
  type LiveScenarioScore,
  type LiveScenarioSpec,
  type ObservedToolCall,
  type ObservedTurn,
  type ProviderFaultRecord,
  type ScenarioObservation,
  scenarioPassed,
  scoreScenario,
  specNeedsRecipient,
  type TrialAggregate,
} from "./live-report.ts";

const SCENARIO_TIMEOUT_MS = 10 * 60_000;
const DELETE_RETRY_ATTEMPTS = 3;
const DELETE_RETRY_DELAY_MS = 2_000;

const DEFAULT_OUT = join(process.cwd(), "apps/engine/eval/out/live-authoring-report.json");

export interface CliArgs {
  engine_url: string;
  scenarios: string[] | null;
  scenarios_file: string | null;
  out: string;
  baseline: string | null;
  trials: number;
  cleanup: boolean;
  recipient: string | null;
  ask_before_writing: boolean;
}

export type ParsedCli = { ok: true; args: CliArgs } | { ok: false; error: string };

function usageText(): string {
  return [
    "Usage: SUBKIT_API_KEY=… bun run apps/engine/eval/live-authoring.ts --engine-url <url>",
    "         [--scenario <slug>[,<slug>…]] [--scenarios-file <scenarios.json>]",
    "         [--out <report.json>] [--baseline <report.json>]",
    "         [--trials <n>] [--cleanup] [--recipient <address>] [--ask-before-writing]",
    "",
    `Scenarios: ${LIVE_SCENARIOS.map((s) => s.slug).join(", ")}`,
    "  (--scenarios-file merges local-only scenarios; same JSON shape as LIVE_SCENARIOS entries)",
    "  --trials runs every selected scenario n times in sequence and aggregates the scores",
    "  --cleanup deletes every workflow, knowledge source, connector and conversation a scenario created",
    "  --recipient binds {recipient} in goals and content checks (env: SUBKIT_EVAL_RECIPIENT)",
    "  --ask-before-writing: the key's user has “Always ask first” on, so write confirmations",
    "    and approvals are required and never count as needless questions",
    "",
    "A canary turn runs first; when the provider fails it twice, nothing is scored (exit 3).",
    "Provider faults (rate limit, 5xx, timeouts) are retried once and reported apart from failures.",
    "Every built-in scenario that passes records its proof in apps/engine/eval/gate.json.",
    "",
    "Env: SUBKIT_ENGINE_URL (fallback for --engine-url), SUBKIT_API_KEY (the only way to pass the key;",
    "it is never accepted as an argument and never printed), SUBKIT_EVAL_RECIPIENT. No .env file is ever read.",
  ].join("\n");
}

export function parseCliArgs(argv: string[], env: Record<string, string | undefined>): ParsedCli {
  let engine_url = env.SUBKIT_ENGINE_URL ?? "";
  let scenarios: string[] | null = null;
  let scenarios_file: string | null = null;
  let out = DEFAULT_OUT;
  let baseline: string | null = null;
  let trials = 1;
  let cleanup = false;
  let recipient = env.SUBKIT_EVAL_RECIPIENT ?? null;
  let ask_before_writing = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string | null => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return null;
      i += 1;
      return v;
    };
    const required = (flag: string): string | ParsedCli => {
      const v = next();
      return v === null ? { ok: false, error: `${flag} needs a value` } : v;
    };
    if (arg === "--help" || arg === "-h") return { ok: false, error: "" };
    if (arg === "--cleanup") {
      cleanup = true;
      continue;
    }
    if (arg === "--ask-before-writing") {
      ask_before_writing = true;
      continue;
    }
    if (arg === "--api-key") {
      return {
        ok: false,
        error:
          "--api-key was removed: pass the key only through the SUBKIT_API_KEY environment variable",
      };
    }
    const value = required(arg ?? "");
    if (typeof value !== "string") return value;
    if (arg === "--engine-url") engine_url = value;
    else if (arg === "--scenario")
      scenarios = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (arg === "--scenarios-file") scenarios_file = value;
    else if (arg === "--out") out = value;
    else if (arg === "--baseline") baseline = value;
    else if (arg === "--recipient") recipient = value;
    else if (arg === "--trials") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1)
        return { ok: false, error: "--trials needs an integer ≥ 1" };
      trials = n;
    } else return { ok: false, error: `unknown argument ${arg}` };
  }
  if (!engine_url) return { ok: false, error: "--engine-url (or SUBKIT_ENGINE_URL) is required" };
  if (!env.SUBKIT_API_KEY)
    return { ok: false, error: "SUBKIT_API_KEY is required in the environment" };
  return {
    ok: true,
    args: {
      engine_url: engine_url.replace(/\/+$/, ""),
      scenarios,
      scenarios_file,
      out,
      baseline,
      trials,
      cleanup,
      recipient,
      ask_before_writing,
    },
  };
}

const ContentCheckSchema = z.object({
  name: z.string(),
  pattern: z.string(),
  flags: z.string().optional(),
});
export const ScenarioFileEntrySchema = z.object({
  slug: z.string().min(1),
  kind: z.enum(["authoring", "clarification"]),
  goal: z.string().min(1),
  follow_up_turns: z.array(z.string().min(1)).optional(),
  answer_turns: z.array(z.string().min(1)).optional(),
  connectors: z.array(z.string()),
  content_checks: z.array(ContentCheckSchema),
  content_source: z.enum(["envelope", "final_output"]).optional(),
  facts: z.array(ContentCheckSchema).optional(),
});
const ScenarioFileSchema = z.array(ScenarioFileEntrySchema);

function loadScenariosFile(path: string): LiveScenarioSpec[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`--scenarios-file: cannot read/parse ${path}: ${(e as Error).message}`);
    process.exit(2);
  }
  const parsed = ScenarioFileSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`--scenarios-file: invalid scenario file ${path}:\n${parsed.error.message}`);
    process.exit(2);
  }
  return parsed.data.map((entry) => ({
    slug: entry.slug,
    kind: entry.kind,
    goal: entry.goal,
    connectors: entry.connectors,
    content_checks: entry.content_checks.map((c) => ({
      name: c.name,
      pattern: c.pattern,
      ...(c.flags !== undefined ? { flags: c.flags } : {}),
    })),
    ...(entry.follow_up_turns ? { follow_up_turns: entry.follow_up_turns } : {}),
    ...(entry.answer_turns ? { answer_turns: entry.answer_turns } : {}),
    ...(entry.content_source ? { content_source: entry.content_source } : {}),
    ...(entry.facts
      ? {
          facts: entry.facts.map((c) => ({
            name: c.name,
            pattern: c.pattern,
            ...(c.flags !== undefined ? { flags: c.flags } : {}),
          })),
        }
      : {}),
  }));
}

export interface TurnEventLike {
  type?: string;
  call_id?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  text?: string;
  role?: string;
  content?: unknown;
  status?: string;
  elicitation_id?: string;
  tool_name?: string;
  usage?: { turn_tokens?: number };
}

export interface TurnOutcomeJson {
  conversation?: { id?: string };
  events?: TurnEventLike[];
  status?: string;
  committed_workflow_id?: string;
  pending_elicitation_id?: string;
}

export interface PendingElicitation {
  id: string;
  tool_name: string | null;
  input: unknown;
}

export interface ProjectedTurn {
  turn: ObservedTurn;
  tokens?: number;
  elicitation: PendingElicitation | null;
}

function assistantTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const rec =
        part !== null && typeof part === "object" ? (part as Record<string, unknown>) : null;
      return rec?.type === "text" && typeof rec.text === "string" ? rec.text : "";
    })
    .join("");
}

export function projectTurn(outcome: TurnOutcomeJson): ProjectedTurn {
  const events = outcome.events ?? [];
  const calls = new Map<string, ObservedToolCall & { settled: boolean }>();
  let deltas = "";
  let messageText = "";
  let tokens: number | undefined;
  let completedStatus: string | undefined;
  const elicits: PendingElicitation[] = [];
  const callOf = (call_id: string, tool: string | undefined) => {
    const existing = calls.get(call_id);
    if (existing) {
      if (!existing.tool && tool) existing.tool = tool;
      return existing;
    }
    const created = {
      call_id,
      tool: tool ?? "",
      input: undefined,
      output: undefined,
      settled: false,
    };
    calls.set(call_id, created);
    return created;
  };
  for (const ev of events) {
    const call_id = typeof ev.call_id === "string" ? ev.call_id : null;
    if (ev.type === "tool_call_start" && call_id) callOf(call_id, ev.tool);
    else if (ev.type === "tool_call_end" && call_id) {
      const call = callOf(call_id, ev.tool);
      call.input = ev.input;
      call.settled = true;
    } else if (ev.type === "tool_result" && call_id) {
      const call = callOf(call_id, ev.tool);
      call.output = ev.output;
      call.settled = true;
    } else if (ev.type === "text_delta" && typeof ev.text === "string") deltas += ev.text;
    else if (ev.type === "message" && ev.role === "assistant") {
      messageText += assistantTextOf(ev.content);
    } else if (ev.type === "completed") {
      if (typeof ev.status === "string") completedStatus = ev.status;
      if (typeof ev.usage?.turn_tokens === "number") {
        tokens = (tokens ?? 0) + ev.usage.turn_tokens;
      }
    } else if (ev.type === "elicit_request" && typeof ev.elicitation_id === "string") {
      elicits.push({
        id: ev.elicitation_id,
        tool_name: typeof ev.tool_name === "string" ? ev.tool_name : null,
        input: ev.input,
      });
    }
  }
  const tool_calls: ObservedToolCall[] = [...calls.values()]
    .filter((c) => c.settled)
    .map(({ settled: _settled, ...call }) => call);
  const pending_elicitation_id =
    outcome.pending_elicitation_id ?? elicits[elicits.length - 1]?.id ?? null;
  let elicitation: PendingElicitation | null = null;
  if (pending_elicitation_id) {
    const announced = elicits.find((e) => e.id === pending_elicitation_id);
    if (announced) {
      elicitation = announced;
    } else {
      const lastAsk = [...tool_calls].reverse().find((c) => ASK_TOOLS.has(c.tool));
      elicitation = {
        id: pending_elicitation_id,
        tool_name: lastAsk?.tool ?? null,
        input: lastAsk?.input,
      };
    }
  }
  return {
    turn: {
      tool_calls,
      assistant_text: deltas.length > 0 ? deltas : messageText,
      status: outcome.status ?? completedStatus ?? "unknown",
      pending_elicitation_id,
      delivered_ask: elicitation
        ? { tool_name: elicitation.tool_name, input: elicitation.input }
        : null,
    },
    ...(tokens !== undefined ? { tokens } : {}),
    elicitation,
  };
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;
const RECIPIENT_NAME_RE = /mail|recipient|empf|address|^to$/i;
const RECIPIENT_LABEL_RE = /mail|recipient|empf|address/i;
const NOT_RECIPIENT_RE = /subject|betreff|content|inhalt|body|source|quelle|data/i;

function isRecipientField(name: string, label: string): boolean {
  if (NOT_RECIPIENT_RE.test(`${name} ${label}`)) return false;
  return RECIPIENT_NAME_RE.test(name) || RECIPIENT_LABEL_RE.test(label);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function firstOptionValue(options: unknown): string | null {
  if (!Array.isArray(options)) return null;
  for (const o of options) {
    if (typeof o === "string") return o;
    const value = asRecord(o)?.value;
    if (typeof value === "string") return value;
  }
  return null;
}

export function answerForElicitation(
  tool_name: string | null,
  input: unknown,
  answer: string,
): unknown {
  const inputObj = asRecord(input);
  switch (tool_name) {
    case "ask_user_form": {
      const fields = Array.isArray(inputObj?.fields) ? inputObj.fields : [];
      const values: Record<string, unknown> = {};
      const email = answer.match(EMAIL_RE)?.[0] ?? null;
      for (const f of fields) {
        const field = asRecord(f);
        const name = typeof field?.name === "string" ? field.name : null;
        if (!field || !name) continue;
        const type = typeof field.type === "string" ? field.type : "text";
        const label = typeof field.label === "string" ? field.label : "";
        if (type === "select") values[name] = firstOptionValue(field.options) ?? answer;
        else if (type === "multi") {
          const first = firstOptionValue(field.options);
          values[name] = first === null ? [] : [first];
        } else if (type === "boolean") values[name] = true;
        else if (type === "number") {
          const n = answer.match(/-?\d+(?:\.\d+)?/)?.[0];
          values[name] = n === undefined ? 0 : Number(n);
        } else if (email && isRecipientField(name, label)) values[name] = email;
        else values[name] = answer;
      }
      return { values };
    }
    case "ask_user_choice":
      return { value: firstOptionValue(inputObj?.options) ?? answer };
    case "ask_user_multi": {
      const first = firstOptionValue(inputObj?.options);
      return { values: first === null ? [] : [first] };
    }
    case "ask_user_confirm":
      return { confirmed: false, reason: answer };
    default:
      return { text: answer };
  }
}

export function provenScenarios(
  scores: LiveScenarioScore[],
  faults: ProviderFaultRecord[],
): Set<string> {
  const bySlug = new Map<string, LiveScenarioScore[]>();
  for (const score of scores)
    bySlug.set(score.scenario, [...(bySlug.get(score.scenario) ?? []), score]);
  const proven = new Set<string>();
  for (const [slug, trials] of bySlug) {
    if (faults.some((f) => f.scenario === slug)) continue;
    if (trials.every(scenarioPassed)) proven.add(slug);
  }
  return proven;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface EngineClient {
  engine_url: string;
  request(path: string, init?: RequestInit): Promise<Response>;
}

export function createEngineClient(
  engine_url: string,
  api_key: string,
  fetchImpl: FetchLike = fetch,
): EngineClient {
  const base = engine_url.replace(/\/+$/, "");
  return {
    engine_url: base,
    request(path, init) {
      return fetchImpl(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${api_key}`,
          "content-type": "application/json",
          accept: "application/json",
          ...(init?.headers ?? {}),
        },
        signal: AbortSignal.timeout(SCENARIO_TIMEOUT_MS),
      });
    },
  };
}

function errorObservation(
  spec: LiveRunSpec,
  started: number,
  turns: ObservedTurn[],
  created_artifacts: CreatedArtifact[],
  error: string,
): ScenarioObservation {
  return {
    scenario: spec.slug,
    tool_calls: turns.reduce((n, t) => n + t.tool_calls.length, 0),
    results: turns.flatMap((t) => t.tool_calls),
    turns,
    committed_workflow_id: null,
    created_artifacts,
    status: "error",
    wall_ms: Date.now() - started,
    error,
  };
}

async function failureText(res: Response, label: string): Promise<string> {
  const body = await res.text().catch(() => "");
  return `${label} → ${res.status}: ${body.slice(0, 300)}`;
}

async function fetchCreatedArtifacts(
  client: EngineClient,
  conversationId: string,
): Promise<{ artifacts: CreatedArtifact[]; tool_calls: ObservedToolCall[] }> {
  const artifacts: CreatedArtifact[] = [{ kind: "conversation", id: conversationId }];
  const res = await client.request(`/v1/conversations/${conversationId}`).catch(() => null);
  if (!res?.ok) return { artifacts, tool_calls: [] };
  const detail = (await res.json().catch(() => ({}))) as {
    created_resources?: Array<{ kind?: string; id?: string; slug?: string | null }>;
    tool_calls?: Array<{ id?: string; tool?: string; input?: unknown; output?: unknown }>;
  };
  for (const r of detail.created_resources ?? []) {
    if (typeof r.id !== "string") continue;
    if (r.kind !== "workflow" && r.kind !== "connector") continue;
    artifacts.push({ kind: r.kind, id: r.id, ...(r.slug ? { slug: r.slug } : {}) });
  }
  const tool_calls = (detail.tool_calls ?? [])
    .filter(
      (c): c is { id: string; tool: string; input: unknown; output: unknown } =>
        typeof c.tool === "string",
    )
    .map((c) => ({ call_id: c.id ?? "", tool: c.tool, input: c.input, output: c.output }));
  return { artifacts, tool_calls };
}

export async function runScenario(
  client: EngineClient,
  spec: LiveRunSpec,
): Promise<ScenarioObservation> {
  const started = Date.now();
  const turns: ObservedTurn[] = [];
  let conversationId: string | null = null;
  let committed: string | null = null;
  let tokens: number | undefined;
  let pending: PendingElicitation | null = null;
  const absorb = (outcome: TurnOutcomeJson) => {
    const projected = projectTurn(outcome);
    turns.push(projected.turn);
    if (projected.tokens !== undefined) tokens = (tokens ?? 0) + projected.tokens;
    if (typeof outcome.committed_workflow_id === "string")
      committed = outcome.committed_workflow_id;
    pending = projected.elicitation;
  };
  const artifactsSoFar = async () =>
    conversationId ? (await fetchCreatedArtifacts(client, conversationId)).artifacts : [];
  try {
    const res = await client.request("/v1/conversations", {
      method: "POST",
      body: JSON.stringify({
        initial_message: spec.goal,
        title: `${EVAL_LIVE_TITLE_PREFIX}${spec.slug}`,
      }),
    });
    if (!res.ok) {
      return errorObservation(
        spec,
        started,
        turns,
        [],
        await failureText(res, "POST /v1/conversations"),
      );
    }
    const first = (await res.json()) as TurnOutcomeJson;
    conversationId = first.conversation?.id ?? null;
    absorb(first);

    const sendTurn = async (message: string): Promise<string | null> => {
      if (!conversationId) return "conversation id missing";
      const current: PendingElicitation | null = pending;
      const turnRes = current
        ? await client.request(
            `/v1/conversations/${conversationId}/elicitations/${current.id}/respond`,
            {
              method: "POST",
              body: JSON.stringify({
                output: answerForElicitation(current.tool_name, current.input, message),
              }),
            },
          )
        : await client.request(`/v1/conversations/${conversationId}/messages`, {
            method: "POST",
            body: JSON.stringify({ message }),
          });
      if (!turnRes.ok) {
        return failureText(
          turnRes,
          current ? "POST …/elicitations/{id}/respond" : "POST …/messages",
        );
      }
      absorb((await turnRes.json()) as TurnOutcomeJson);
      return null;
    };

    for (const answer of spec.answer_turns ?? []) {
      const failure = await sendTurn(answer);
      if (failure) return errorObservation(spec, started, turns, await artifactsSoFar(), failure);
    }
    for (const followUp of spec.follow_up_turns ?? []) {
      const failure = await sendTurn(followUp);
      if (failure) return errorObservation(spec, started, turns, await artifactsSoFar(), failure);
    }

    const wall_ms = Date.now() - started;
    let created_artifacts: CreatedArtifact[] = [];
    if (conversationId) {
      const detail = await fetchCreatedArtifacts(client, conversationId);
      created_artifacts = detail.artifacts;
      const observedCalls = turns.reduce((n, t) => n + t.tool_calls.length, 0);
      if (observedCalls === 0 && detail.tool_calls.length > 0 && turns[0]) {
        turns[0].tool_calls = detail.tool_calls;
      }
    }
    const results = turns.flatMap((t) => t.tool_calls);
    return {
      scenario: spec.slug,
      tool_calls: results.length,
      results,
      turns,
      committed_workflow_id: committed,
      created_artifacts,
      status: turns[turns.length - 1]?.status ?? "unknown",
      wall_ms,
      ...(tokens !== undefined ? { tokens } : {}),
    };
  } catch (err) {
    return errorObservation(
      spec,
      started,
      turns,
      await artifactsSoFar(),
      err instanceof Error ? err.message : String(err),
    );
  }
}

const DELETE_PATHS: Record<CreatedArtifact["kind"], (id: string) => string> = {
  workflow: (id) => `/v1/workflows/${id}`,
  knowledge_source: (id) => `/v1/knowledge-sources/${id}`,
  connector: (id) => `/v1/connectors/${id}`,
  conversation: (id) => `/v1/conversations/${id}`,
};

export interface DeletionResult {
  deleted: CreatedArtifact[];
  failures: string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function deleteArtifacts(
  client: EngineClient,
  artifacts: CreatedArtifact[],
  opts: { retryDelayMs?: number } = {},
): Promise<DeletionResult> {
  const deleted: CreatedArtifact[] = [];
  const failures: string[] = [];
  for (const artifact of deletionOrder(artifacts)) {
    const label = `${artifact.kind}:${artifact.id}${artifact.slug ? ` (${artifact.slug})` : ""}`;
    let outcome: string | null = `${label} → not attempted`;
    for (let attempt = 1; attempt <= DELETE_RETRY_ATTEMPTS; attempt++) {
      try {
        const res = await client.request(DELETE_PATHS[artifact.kind](artifact.id), {
          method: "DELETE",
        });
        if (res.ok || res.status === 404) {
          outcome = null;
          break;
        }
        outcome = await failureText(res, `DELETE ${label}`);
        if (res.status !== 409) break;
      } catch (err) {
        outcome = `DELETE ${label} → ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
      if (attempt < DELETE_RETRY_ATTEMPTS) await sleep(opts.retryDelayMs ?? DELETE_RETRY_DELAY_MS);
    }
    if (outcome === null) deleted.push(artifact);
    else failures.push(outcome);
  }
  return { deleted, failures };
}

function printScore(score: LiveScenarioScore): void {
  const targetLine = Object.entries(score.targets)
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");
  console.log(
    `  kind=${score.kind}  tool_calls=${score.tool_calls}  llm_passes=${score.llm_passes ?? "-"}  previews=${score.previews}  ` +
      `judge=${score.judge ?? "-"}  wall_ms=${score.wall_ms}  content_pass=${score.content_pass}` +
      (score.guard_fired !== null ? `  guard_fired=${score.guard_fired}` : "") +
      (score.auto_repaired_first_preview ? "  AUTO-REPAIRED" : "") +
      (score.tokens !== undefined ? `  tokens=${score.tokens}` : ""),
  );
  console.log(`  ${targetLine}`);
  for (const note of score.notes) console.log(`  note: ${note}`);
}

function printAggregate(agg: TrialAggregate): void {
  const pct = (r: number) => `${Math.round(r * 100)}%`;
  console.log(
    `  trials=${agg.n_trials} (excluded ${agg.excluded_non_isolated})  pass=${pct(agg.pass_rate)}  ` +
      `content=${pct(agg.content_pass_rate)}  converged=${pct(agg.converged_rate)}` +
      (agg.guard_fired_rate !== null ? `  guard_fired=${pct(agg.guard_fired_rate)}` : "") +
      `  median_tool_calls=${agg.median_tool_calls ?? "-"}`,
  );
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    if (parsed.error) console.error(parsed.error);
    console.error(usageText());
    process.exit(2);
  }
  const args = parsed.args;
  const client = createEngineClient(args.engine_url, process.env.SUBKIT_API_KEY ?? "");
  const fileScenarios = args.scenarios_file ? loadScenariosFile(args.scenarios_file) : [];
  const candidates: LiveScenarioSpec[] = [
    ...LIVE_SCENARIOS.filter((s) => !fileScenarios.some((f) => f.slug === s.slug)),
    ...fileScenarios,
  ];
  const selected = args.scenarios
    ? candidates.filter((s) => args.scenarios?.includes(s.slug))
    : candidates;
  if (args.scenarios && selected.length !== args.scenarios.length) {
    const known = new Set(candidates.map((s) => s.slug));
    console.error(`unknown scenario(s): ${args.scenarios.filter((s) => !known.has(s)).join(", ")}`);
    console.error(usageText());
    process.exit(2);
  }
  const needingRecipient = selected.filter(specNeedsRecipient).map((s) => s.slug);
  if (needingRecipient.length > 0 && !args.recipient) {
    console.error(
      `scenario(s) ${needingRecipient.join(", ")} use {recipient}: pass --recipient or set SUBKIT_EVAL_RECIPIENT`,
    );
    process.exit(2);
  }
  const specs = args.recipient
    ? selected.map((s) => bindScenarioInputs(s, { recipient: args.recipient ?? "" }))
    : selected;

  const builtIn = new Map(
    LIVE_SCENARIOS.filter((s) => !fileScenarios.some((f) => f.slug === s.slug)).map((s) => [
      s.slug,
      s,
    ]),
  );
  const gate = readGate();
  const fingerprints = liveFingerprints(LIVE_SCENARIOS);
  const before = gateStatus(gate.live, fingerprints);
  for (const slug of before.changed) console.log(`gate: ${slug} changed after its last proven run`);
  for (const slug of before.unproven) console.log(`gate: ${slug} has no proven run yet`);

  const started_at = new Date().toISOString();
  console.log(
    `live-authoring eval → ${args.engine_url} (${specs.length} scenario(s) × ${args.trials} trial(s)` +
      `${args.cleanup ? ", cleanup on" : ""})\n`,
  );

  const scores: LiveScenarioScore[] = [];
  const observations: ScenarioObservation[] = [];
  const trialAggregates: TrialAggregate[] = [];
  const cleanupTotals = { deleted: 0, failures: [] as string[] };
  const awaitingCleanup = new Map<string, CreatedArtifact[]>();

  const cleanupNow = async (key: string): Promise<void> => {
    const artifacts = awaitingCleanup.get(key);
    if (!artifacts) return;
    awaitingCleanup.delete(key);
    if (artifacts.length === 0) return;
    const result = await deleteArtifacts(client, artifacts);
    cleanupTotals.deleted += result.deleted.length;
    cleanupTotals.failures.push(...result.failures);
    console.log(
      `  cleanup: deleted ${result.deleted.length}/${artifacts.length}` +
        (result.failures.length > 0 ? `  FAILED ${result.failures.length}` : ""),
    );
    for (const failure of result.failures) console.log(`  cleanup failure: ${failure}`);
  };

  const runWithRetry = (spec: LiveRunSpec, key: string) =>
    withFaultRetry(
      async () => {
        const obs = await runScenario(client, spec);
        observations.push(obs);
        if (args.cleanup) awaitingCleanup.set(key, collectCreatedArtifacts(obs));
        return { value: obs, error: obs.error };
      },
      async (_obs, fault, error, attempt) => {
        console.log(`  provider fault (${fault}), attempt ${attempt}/${MAX_ATTEMPTS}: ${error}`);
        if (args.cleanup) await cleanupNow(key);
      },
    );

  console.log(`▶ ${CANARY_SPEC.slug}`);
  const canary = canaryVerdict(await runWithRetry(CANARY_SPEC, CANARY_SPEC.slug));
  if (args.cleanup) await cleanupNow(CANARY_SPEC.slug);
  if (!canary.ok) {
    console.error(`canary: ${canary.reason}; nothing was scored`);
    process.exit(canary.provider_down ? 3 : 1);
  }
  console.log("  canary: provider answers\n");

  const provider_faults: ProviderFaultRecord[] = [];
  try {
    for (const spec of specs) {
      const trialScores: LiveScenarioScore[] = [];
      for (let trial = 1; trial <= args.trials; trial++) {
        console.log(
          args.trials > 1 ? `▶ ${spec.slug} [trial ${trial}/${args.trials}]` : `▶ ${spec.slug}`,
        );
        const key = `${spec.slug}#${trial}`;
        const outcome = await runWithRetry(spec, key);
        if (outcome.kind === "faulted") {
          provider_faults.push({
            scenario: spec.slug,
            trial,
            fault: outcome.fault,
            error: outcome.error,
          });
          console.log(`  not scored: provider fault (${outcome.fault}) on every attempt`);
          if (args.cleanup) await cleanupNow(key);
          console.log("");
          continue;
        }
        const score = scoreScenario(spec, outcome.value, {
          ask_before_writing: args.ask_before_writing,
        });
        scores.push(score);
        trialScores.push(score);
        printScore(score);
        if (args.cleanup) await cleanupNow(key);
        console.log("");
      }
      if (args.trials > 1 && trialScores.length > 0) {
        const agg = aggregateTrials(trialScores);
        trialAggregates.push(agg);
        console.log(`Σ ${spec.slug}`);
        printAggregate(agg);
        console.log("");
      }
    }
  } finally {
    for (const key of [...awaitingCleanup.keys()]) await cleanupNow(key);
  }

  const report = buildLiveReport({
    scores,
    engine_host: new URL(args.engine_url).host,
    started_at,
    finished_at: new Date().toISOString(),
    ...(trialAggregates.length > 0 ? { trials: trialAggregates } : {}),
    ...(args.cleanup ? { cleanup: cleanupTotals } : {}),
    provider_faults,
  });

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const resultsOut = `${args.out.replace(/\.json$/, "")}.results.json`;
  writeFileSync(resultsOut, `${JSON.stringify(observations, null, 2)}\n`, "utf8");
  console.log(`Report: ${args.out}`);
  console.log(`Raw observations: ${resultsOut}`);
  console.log(
    `Scenarios: ${report.total}   PASS: ${report.passed}   FAIL: ${report.failed}   ` +
      `provider faults: ${provider_faults.length}`,
  );
  for (const f of provider_faults) {
    console.log(`  provider fault ${f.scenario} [trial ${f.trial}] ${f.fault}: ${f.error}`);
  }
  const proven = provenScenarios(
    scores.filter((s) => builtIn.has(s.scenario) && specs.some((spec) => spec.slug === s.scenario)),
    provider_faults,
  );
  const nextGate = recordProofs(gate, "live", fingerprints, proven, provenOn(new Date()));
  writeGate(nextGate);
  if (proven.size > 0) console.log(`gate: proven ${[...proven].sort().join(", ")}`);
  if (args.cleanup) {
    console.log(
      `Cleanup: deleted ${cleanupTotals.deleted}   failures: ${cleanupTotals.failures.length}`,
    );
  }

  let passed = report.scenarios.every((s) => scenarioPassed(s));
  if (args.baseline) {
    const baseline = JSON.parse(readFileSync(args.baseline, "utf8")) as LiveAuthoringReport;
    const comparison = compareLiveAuthoringReports(baseline, report);
    console.log(
      `Benchmark: ${comparison.common_scenarios} common, ` +
        `${comparison.regressions.length} regression(s), ${comparison.changes.length} change(s)`,
    );
    for (const change of comparison.changes) {
      const prefix = change.severity === "regression" ? "REGRESSION" : change.severity;
      console.log(`  ${prefix} ${change.scenario} ${change.metric}: ${change.message}`);
    }
    passed &&= comparison.passed;
  }
  if (cleanupTotals.failures.length > 0) passed = false;
  if (scores.length === 0 && provider_faults.length > 0) {
    console.error("every scenario hit a provider fault; nothing was scored");
    process.exit(3);
  }

  process.exit(passed ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
