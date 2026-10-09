import { readFileSync } from "node:fs";
import {
  applyFlowModelElevation,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_PRIMARY_MODEL,
} from "../apps/engine/src/llm/core/invoke.ts";
import type { LlmFlow, ModelRoute } from "../apps/engine/src/llm/types.ts";

export interface LiveArgs {
  keyFile: string;
  openaiKeyFile: string;
  models: string[];
  timeoutMs: number;
}

export type LiveProvider = "anthropic" | "openai";

export interface LiveModelRef {
  provider: LiveProvider;
  model: string;
}

export const DEFAULT_KEY_FILE = "key.txt";
export const DEFAULT_OPENAI_KEY_FILE = "openai-key.txt";

export function parseModelRef(ref: string): LiveModelRef {
  const at = ref.indexOf(":");
  if (at === -1) return { provider: "anthropic", model: ref };
  const provider = ref.slice(0, at);
  const model = ref.slice(at + 1);
  if (provider !== "anthropic" && provider !== "openai") {
    throw new Error(
      `unknown provider "${provider}" in ${ref} (use anthropic:<model> or openai:<model>)`,
    );
  }
  if (model.length === 0) throw new Error(`model id missing in ${ref}`);
  return { provider, model };
}
export const DEFAULT_TIMEOUT_MS = 60_000;
export const LIVE_INPUT_BYTE_LIMIT = 65_536;
export const LIVE_OUTPUT_TOKEN_LIMITS = {
  generate_workflow: 1024,
  judge_verdict: 512,
  tool_input_examples: 512,
} as const;

export function assertLiveInputBound(input: unknown): number {
  const bytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  if (bytes > LIVE_INPUT_BYTE_LIMIT) {
    throw new Error(`live gate input exceeds ${LIVE_INPUT_BYTE_LIMIT} bytes`);
  }
  return bytes;
}

export function parseLiveArgs(argv: string[]): LiveArgs {
  const args: LiveArgs = {
    keyFile: DEFAULT_KEY_FILE,
    openaiKeyFile: DEFAULT_OPENAI_KEY_FILE,
    models: [DEFAULT_PRIMARY_MODEL, DEFAULT_FALLBACK_MODEL],
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--key-file":
        if (!value) throw new Error("--key-file needs a path");
        args.keyFile = value;
        i++;
        break;
      case "--openai-key-file":
        if (!value) throw new Error("--openai-key-file needs a path");
        args.openaiKeyFile = value;
        i++;
        break;
      case "--models": {
        if (!value) throw new Error("--models needs a comma-separated list of model ids");
        const models = value
          .split(",")
          .map((m) => m.trim())
          .filter((m) => m.length > 0);
        if (models.length === 0) throw new Error("--models needs at least one model id");
        for (const m of models) parseModelRef(m);
        args.models = models;
        i++;
        break;
      }
      case "--timeout-ms": {
        if (!value) throw new Error("--timeout-ms needs a value");
        const ms = Number(value);
        if (!Number.isInteger(ms) || ms <= 0) {
          throw new Error(`--timeout-ms must be a positive integer, got ${value}`);
        }
        args.timeoutMs = ms;
        i++;
        break;
      }
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

export function readKeyFile(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const key = raw.trim();
  return key.length > 0 ? key : null;
}

export type LiveCheckName = "generate_workflow" | "judge_verdict" | "tool_input_examples";

export const LIVE_CHECK_NAMES: ReadonlyArray<LiveCheckName> = [
  "generate_workflow",
  "judge_verdict",
  "tool_input_examples",
];

export interface LiveCheckResult {
  model: string;
  check: LiveCheckName;
  status: "PASS" | "FAIL";
  ms: number;
  detail: string;
}

export function orderedForFlow(models: string[], flow: LlmFlow): string[] {
  const [primary, fallback, ...rest] = models;
  if (primary === undefined || fallback === undefined) return [...models];
  const route: ModelRoute = {
    tenant_id: "live-gate",
    primary,
    fallback,
    provider: "anthropic",
    fallback_provider: "anthropic",
    context_cap: 0,
    monthly_budget: null,
  };
  const elevated = applyFlowModelElevation(route, flow);
  return [elevated.primary, elevated.fallback, ...rest];
}

type TableRow = Record<"model" | "check" | "status" | "ms" | "detail", string>;

const TABLE_HEADER: TableRow = {
  model: "MODEL",
  check: "CHECK",
  status: "STATUS",
  ms: "MS",
  detail: "DETAIL",
};

export function renderTable(results: LiveCheckResult[]): string {
  const rows: TableRow[] = results.map((r) => ({
    model: r.model,
    check: r.check,
    status: r.status,
    ms: String(r.ms),
    detail: r.detail,
  }));
  const width = (key: keyof TableRow): number =>
    Math.max(TABLE_HEADER[key].length, ...rows.map((r) => r[key].length));
  const w = {
    model: width("model"),
    check: width("check"),
    status: width("status"),
    ms: width("ms"),
  };
  const line = (r: TableRow): string =>
    [
      r.model.padEnd(w.model),
      r.check.padEnd(w.check),
      r.status.padEnd(w.status),
      r.ms.padStart(w.ms),
      r.detail,
    ].join("  ");
  return [line(TABLE_HEADER), ...rows.map(line)].join("\n");
}

export function exitCodeFor(results: LiveCheckResult[], keyPresent: boolean): 0 | 1 | 2 {
  if (!keyPresent) return 2;
  if (results.length === 0) return 1;
  return results.some((r) => r.status === "FAIL") ? 1 : 0;
}

export function liveGateFailureHint(tag: string): string {
  return [
    `release:tag: refusing to tag ${tag} — the live LLM gate (bun run verify:llm-live) did not pass.`,
    `The gate reads the Anthropic key from ./${DEFAULT_KEY_FILE} (--key-file <path>) and the OpenAI key from ./${DEFAULT_OPENAI_KEY_FILE} (--openai-key-file <path>)`,
    "and exercises the release models; pass the deployed route as provider:model, primary first:",
    "  bun run release:tag -- --models anthropic:<primary>,openai:<fallback>",
    "A failing or unreachable model blocks the release; there is no bypass flag.",
  ].join("\n");
}

const SECRET_PATTERN = /(sk-ant-|wf_live_)[A-Za-z0-9_-]+/g;
const DETAIL_MAX_CHARS = 200;

export function redactDetail(detail: string, secrets: ReadonlyArray<string> = []): string {
  let out = detail;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("***");
  }
  out = out.replace(SECRET_PATTERN, "$1***").replace(/\s+/g, " ").trim();
  return out.length > DETAIL_MAX_CHARS ? `${out.slice(0, DETAIL_MAX_CHARS - 1)}…` : out;
}
