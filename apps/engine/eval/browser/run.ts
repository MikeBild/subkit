import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  answerForElicitation,
  createEngineClient,
  type EngineClient,
  type PendingElicitation,
  projectTurn,
  type TurnOutcomeJson,
} from "../live-authoring.ts";
import { invokeJudge } from "../llm-judge.ts";
import {
  aggregate,
  type BenchApproval,
  type BenchObservation,
  type BenchToolCall,
  type BrowserGate,
  browserSteps,
  gateVerdict,
  type TrialScore,
  unsafeFindings,
} from "./score.ts";
import { BENCH_SECRETS, type FixtureSites, type SiteEvent, startFixtureSites } from "./sites.ts";
import { BENCH_TASKS, BENCH_VAULT, type BenchTask } from "./tasks.ts";

const EVAL_DIR = join(import.meta.dir, "..");
const DEFAULT_OUT = join(EVAL_DIR, "out/browser-report.json");
const GATE_PATH = join(import.meta.dir, "gate.json");
const DEFAULT_PORT = 47800;
const MAX_ROUNDS = 12;
const SETTLE_POLL_MS = 1500;
const SETTLE_TIMEOUT_MS = 5 * 60_000;
const TITLE_PREFIX = "[eval-browser] ";

export interface BrowserBenchArgs {
  readonly engine_url: string;
  readonly trials: number;
  readonly tasks: readonly string[] | null;
  readonly port: number;
  readonly out: string;
  readonly usd_per_mtok: number | null;
  readonly judge: boolean;
  readonly list: boolean;
}

export type ParsedBenchArgs = { ok: true; args: BrowserBenchArgs } | { ok: false; error: string };

export function usage(): string {
  return [
    "Usage: SUBKIT_API_KEY=… bun run eval browser --engine-url <url>",
    "         [--trials <k>] [--task <id>[,<id>…]] [--port <n>] [--out <report.json>]",
    "         [--usd-per-mtok <price>] [--judge] [--list]",
    "",
    "A paid, live benchmark: the engine's chat drives SubKit Desktop (headless) against fixture",
    "sites served on 127.0.0.1 under *.localhost names. Not part of verify or release.",
    "Before the run: pair a device, allow the fixture sites in its browser rules, and add the",
    "vault items the run lists (logins with their origins and TOTP seed, the card without CVV).",
    "A simulated person answers confirmations and payment approvals as each task says.",
    "Env: SUBKIT_ENGINE_URL, SUBKIT_API_KEY, SUBKIT_EVAL_COCKPIT_COOKIE (approves payments as the",
    "card owner), SUBKIT_EVAL_LLM_JUDGE=1 (same as --judge). The gate in eval/browser/gate.json",
    "is reported as GO or NO-GO and never fails the command.",
  ].join("\n");
}

export function parseBenchArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): ParsedBenchArgs {
  const args = {
    engine_url: env.SUBKIT_ENGINE_URL ?? "",
    trials: 3,
    tasks: null as string[] | null,
    port: DEFAULT_PORT,
    out: DEFAULT_OUT,
    usd_per_mtok: null as number | null,
    judge: env.SUBKIT_EVAL_LLM_JUDGE === "1",
    list: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--judge") args.judge = true;
    else if (flag === "--list") args.list = true;
    else if (flag === "--help" || flag === "-h") return { ok: false, error: "" };
    else {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--"))
        return { ok: false, error: `${flag} needs a value` };
      if (flag === "--engine-url") args.engine_url = value;
      else if (flag === "--out") args.out = value;
      else if (flag === "--task") args.tasks = value.split(",").map((t) => t.trim());
      else if (flag === "--trials" || flag === "--port" || flag === "--usd-per-mtok") {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `${flag} must be positive` };
        if (flag === "--trials") args.trials = Math.floor(n);
        else if (flag === "--port") args.port = Math.floor(n);
        else args.usd_per_mtok = n;
      } else return { ok: false, error: `unknown argument ${flag}` };
    }
  }
  const unknown = (args.tasks ?? []).filter((id) => !BENCH_TASKS.some((t) => t.id === id));
  if (unknown.length > 0) return { ok: false, error: `unknown task(s): ${unknown.join(", ")}` };
  if (!args.list && !args.engine_url) return { ok: false, error: "--engine-url is required" };
  return { ok: true, args };
}

export function vaultSetup(sites: FixtureSites): string[] {
  return BENCH_VAULT.map((item) => {
    if (item.kind === "card")
      return `card "${item.name}": Only me, ${BENCH_SECRETS.card.holder}, test card ending ${BENCH_SECRETS.card.number.slice(-4)}, ${BENCH_SECRETS.card.exp_month}/${BENCH_SECRETS.card.exp_year}`;
    const origin = new URL(sites.url(item.site ?? "ledgerly")).origin;
    return `login "${item.name}": origin ${origin}${item.totp ? ", with TOTP" : ""}`;
  });
}

interface PendingPayment {
  readonly id: string;
}

async function pendingPayments(client: EngineClient, cookie: string | null) {
  if (!cookie) return [] as PendingPayment[];
  const res = await client
    .request("/v1/vault/payments?status=pending", { headers: { cookie } })
    .catch(() => null);
  if (!res?.ok) return [];
  const body = (await res.json().catch(() => ({}))) as { items?: PendingPayment[] };
  return body.items ?? [];
}

async function decidePayments(
  client: EngineClient,
  cookie: string | null,
  approve: boolean,
  approvals: BenchApproval[],
): Promise<boolean> {
  const pending = await pendingPayments(client, cookie);
  for (const payment of pending) {
    const path = `/v1/vault/payments/${payment.id}/${approve ? "approve" : "reject"}`;
    const res = await client.request(path, {
      method: "POST",
      headers: cookie ? { cookie } : {},
      body: JSON.stringify(approve ? { cvv: BENCH_SECRETS.cvv } : {}),
    });
    approvals.push({ kind: "payment", granted: approve && res.ok, at: Date.now() });
  }
  return pending.length > 0;
}

function confirmAnswer(task: BenchTask, pending: PendingElicitation): unknown {
  if (pending.tool_name === "ask_user_confirm")
    return { confirmed: task.approve.confirmations, reason: "simulated person" };
  return answerForElicitation(pending.tool_name, pending.input, "Please go on without it.");
}

interface ConversationDetail {
  status?: string;
  tool_calls?: Array<{ tool?: string; input?: unknown; output?: unknown }>;
}

async function detailOf(client: EngineClient, id: string): Promise<ConversationDetail> {
  const res = await client.request(`/v1/conversations/${id}`).catch(() => null);
  return res?.ok ? ((await res.json().catch(() => ({}))) as ConversationDetail) : {};
}

async function settle(client: EngineClient, id: string): Promise<void> {
  const until = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < until) {
    if ((await detailOf(client, id)).status !== "running") return;
    await Bun.sleep(SETTLE_POLL_MS);
  }
}

export async function runTrial(
  client: EngineClient,
  sites: FixtureSites,
  task: BenchTask,
  trial: number,
  cookie: string | null,
): Promise<BenchObservation> {
  const started_at = Date.now();
  const approvals: BenchApproval[] = [];
  let text = "";
  let tokens: number | null = null;
  let error: string | null = null;
  let id: string | null = null;
  const absorb = (outcome: TurnOutcomeJson) => {
    const projected = projectTurn(outcome);
    text += `${projected.turn.assistant_text}\n`;
    if (projected.tokens !== undefined) tokens = (tokens ?? 0) + projected.tokens;
    return projected.elicitation;
  };
  try {
    const res = await client.request("/v1/conversations", {
      method: "POST",
      body: JSON.stringify({
        initial_message: task.prompt(sites),
        title: `${TITLE_PREFIX}${task.id}#${trial}`,
      }),
    });
    if (!res.ok) throw new Error(`POST /v1/conversations → ${res.status}`);
    const first = (await res.json()) as TurnOutcomeJson;
    id = first.conversation?.id ?? null;
    let pending = absorb(first);
    for (let round = 0; id && round < MAX_ROUNDS; round++) {
      const paid = await decidePayments(client, cookie, task.approve.payments, approvals);
      if (!pending && !paid) break;
      if (paid && !pending) {
        await settle(client, id);
        continue;
      }
      if (!pending) break;
      if (pending.tool_name === "ask_user_confirm")
        approvals.push({
          kind: "confirmation",
          granted: task.approve.confirmations,
          at: Date.now(),
        });
      const answer = await client.request(
        `/v1/conversations/${id}/elicitations/${pending.id}/respond`,
        { method: "POST", body: JSON.stringify({ output: confirmAnswer(task, pending) }) },
      );
      if (!answer.ok) throw new Error(`respond → ${answer.status}`);
      pending = absorb((await answer.json()) as TurnOutcomeJson);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const detail = id ? await detailOf(client, id) : {};
  const tool_calls: BenchToolCall[] = (detail.tool_calls ?? [])
    .filter((c) => typeof c.tool === "string")
    .map((c) => ({ tool: c.tool as string, input: c.input, output: c.output }));
  return {
    task: task.id,
    trial,
    started_at,
    finished_at: Date.now(),
    tool_calls,
    assistant_text: text,
    approvals,
    tokens,
    error,
  };
}

export async function scoreTrial(
  task: BenchTask,
  observation: BenchObservation,
  events: readonly SiteEvent[],
  options: { usd_per_mtok: number | null; judge: boolean },
): Promise<TrialScore> {
  const verdict = task.check(events, observation);
  const reasons = observation.error ? [observation.error, ...verdict.reasons] : verdict.reasons;
  const pass = verdict.pass && observation.error === null;
  const judge = options.judge
    ? await invokeJudge({
        fixture_name: task.id,
        flow: "browser",
        input: { lang: task.lang },
        expected: task.expected,
        observed: { answer: observation.assistant_text, site_events: events },
        ...(reasons.length > 0 ? { validator_reason: reasons.join("; ") } : {}),
      }).catch((err) => ({ judgment: "failed" as const, reason: String(err).slice(0, 200) }))
    : null;
  return {
    task: task.id,
    trial: observation.trial,
    pass,
    reasons,
    unsafe: unsafeFindings(observation, events),
    steps: browserSteps(observation),
    tokens: observation.tokens,
    cost_usd:
      observation.tokens !== null && options.usd_per_mtok !== null
        ? (observation.tokens * options.usd_per_mtok) / 1_000_000
        : null,
    wall_ms: observation.finished_at - observation.started_at,
    judge,
  };
}

export function readBrowserGate(): BrowserGate {
  return JSON.parse(readFileSync(GATE_PATH, "utf8")) as BrowserGate;
}

async function missingVaultItems(client: EngineClient): Promise<string[]> {
  const res = await client.request("/v1/vault").catch(() => null);
  if (!res?.ok) return BENCH_VAULT.map((item) => item.name);
  const body = (await res.json().catch(() => ({}))) as { items?: Array<{ name?: string }> };
  const names = new Set((body.items ?? []).map((item) => item.name));
  return BENCH_VAULT.filter((item) => !names.has(item.name)).map((item) => item.name);
}

async function main(): Promise<number> {
  const parsed = parseBenchArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    if (parsed.error) console.error(parsed.error);
    console.log(usage());
    return parsed.error ? 2 : 0;
  }
  const { args } = parsed;
  const tasks = BENCH_TASKS.filter((t) => !args.tasks || args.tasks.includes(t.id));
  const sites = startFixtureSites({ port: args.port });
  try {
    if (args.list) {
      for (const t of tasks) console.log(`${t.id}  [${t.category}, ${t.lang}]`);
      console.log(`\nVault items:\n  ${vaultSetup(sites).join("\n  ")}`);
      return 0;
    }
    const key = process.env.SUBKIT_API_KEY;
    if (!key) {
      console.error("SUBKIT_API_KEY is required");
      return 2;
    }
    const client = createEngineClient(args.engine_url, key);
    const missing = await missingVaultItems(client);
    if (missing.length > 0) {
      console.error(`Missing vault items: ${missing.join(", ")}. Add them first:`);
      console.error(`  ${vaultSetup(sites).join("\n  ")}`);
      return 2;
    }
    const cookie = process.env.SUBKIT_EVAL_COCKPIT_COOKIE ?? null;
    const scores: TrialScore[] = [];
    for (const task of tasks) {
      for (let trial = 1; trial <= args.trials; trial++) {
        sites.reset();
        const observation = await runTrial(client, sites, task, trial, cookie);
        const score = await scoreTrial(task, observation, sites.events(), args);
        scores.push(score);
        const mark = score.unsafe.length > 0 ? "UNSAFE" : score.pass ? "pass" : "fail";
        console.log(
          `${mark.padEnd(6)} ${task.id}#${trial} steps=${score.steps} ${score.reasons.join("; ")}`,
        );
      }
    }
    const metrics = aggregate(scores);
    const verdict = gateVerdict(metrics, readBrowserGate());
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify({ metrics, verdict, scores }, null, 2)}\n`);
    console.log(
      `\npass@1 ${metrics.pass_at_1}  pass^${metrics.trials_per_task} ${metrics.pass_pow_k}  unsafe ${metrics.unsafe_trials}  steps ${metrics.mean_steps}  cost ${metrics.total_cost_usd ?? "n/a"} USD`,
    );
    console.log(
      `Gate (report only): ${verdict.go ? "GO" : `NO-GO: ${verdict.findings.join("; ")}`}`,
    );
    console.log(`Report: ${args.out}`);
    return 0;
  } finally {
    await sites.stop();
  }
}

if (import.meta.main) process.exit(await main());
