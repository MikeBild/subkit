import { createEngineClient, deleteArtifacts, type EngineClient } from "./live-authoring.ts";
import { type CreatedArtifact, deletionOrder, EVAL_LIVE_TITLE_PREFIX } from "./live-report.ts";

export interface SweepListing {
  conversations: Array<{ id: string; title: string | null }>;
  workflows: Array<{ id: string; slug: string | null }>;
  connectors: Array<{ id: string; slug: string | null }>;
}

export interface SweepFilters {
  titlePrefix: string;
  workflowSlugs: string[];
  connectorSlugs: string[];
}

export function sweepPlan(listing: SweepListing, filters: SweepFilters): CreatedArtifact[] {
  const workflowSlugs = new Set(filters.workflowSlugs.filter(Boolean));
  const connectorSlugs = new Set(filters.connectorSlugs.filter(Boolean));
  const plan: CreatedArtifact[] = [];
  for (const w of listing.workflows) {
    if (w.slug && workflowSlugs.has(w.slug))
      plan.push({ kind: "workflow", id: w.id, slug: w.slug });
  }
  for (const c of listing.connectors) {
    if (c.slug && connectorSlugs.has(c.slug)) {
      plan.push({ kind: "connector", id: c.id, slug: c.slug });
    }
  }
  if (filters.titlePrefix.length > 0) {
    for (const conv of listing.conversations) {
      if (conv.title?.startsWith(filters.titlePrefix)) {
        plan.push({ kind: "conversation", id: conv.id, slug: conv.title });
      }
    }
  }
  return deletionOrder(plan);
}

export function renderSweepTable(plan: CreatedArtifact[]): string {
  if (plan.length === 0) return "(nothing to sweep)";
  const rows = plan.map((a) => [a.kind, a.id, a.slug ?? ""]);
  const header = ["kind", "id", "slug / title"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export interface SweepArgs {
  engine_url: string;
  workflowSlugs: string[];
  connectorSlugs: string[];
  yes: boolean;
}

export type ParsedSweep = { ok: true; args: SweepArgs } | { ok: false; error: string };

function usageText(): string {
  return [
    "Usage: SK_API_KEY=… bun run apps/engine/eval/live-sweep.ts --engine-url <url>",
    "         [--workflow-slug a,b] [--connector-slug x] [--yes]",
    "",
    `Lists every conversation titled "${EVAL_LIVE_TITLE_PREFIX}…" plus the workflows and connectors`,
    "with exactly the given slugs, prints the table and deletes them only with --yes.",
    "Env: SK_ENGINE_URL (fallback for --engine-url), SK_API_KEY (never an argument, never printed).",
  ].join("\n");
}

function csv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseSweepArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): ParsedSweep {
  let engine_url = env.SK_ENGINE_URL ?? "";
  const workflowSlugs: string[] = [];
  const connectorSlugs: string[] = [];
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") return { ok: false, error: "" };
    if (arg === "--api-key") {
      return {
        ok: false,
        error: "--api-key is not accepted: pass the key only through SK_API_KEY",
      };
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, error: `${arg} needs a value` };
    }
    i += 1;
    if (arg === "--engine-url") engine_url = value;
    else if (arg === "--workflow-slug") workflowSlugs.push(...csv(value));
    else if (arg === "--connector-slug") connectorSlugs.push(...csv(value));
    else return { ok: false, error: `unknown argument ${arg}` };
  }
  if (!engine_url) return { ok: false, error: "--engine-url (or SK_ENGINE_URL) is required" };
  if (!env.SK_API_KEY) return { ok: false, error: "SK_API_KEY is required in the environment" };
  return {
    ok: true,
    args: { engine_url: engine_url.replace(/\/+$/, ""), workflowSlugs, connectorSlugs, yes },
  };
}

async function listPaged<T>(
  client: EngineClient,
  path: string,
  limit: number,
  pick: (item: Record<string, unknown>) => T | null,
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += limit) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await client.request(`${path}${sep}limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GET ${path} → ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { items?: unknown[]; total?: number };
    const items = Array.isArray(json.items) ? json.items : [];
    for (const item of items) {
      const rec =
        item !== null && typeof item === "object" ? (item as Record<string, unknown>) : null;
      const picked = rec ? pick(rec) : null;
      if (picked) out.push(picked);
    }
    const total = typeof json.total === "number" ? json.total : offset + items.length;
    if (items.length < limit || offset + items.length >= total) break;
  }
  return out;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export async function listSweepCandidates(client: EngineClient): Promise<SweepListing> {
  const [conversations, workflows, connectors] = await Promise.all([
    listPaged(client, "/v1/conversations?hidden=all", 200, (r) =>
      str(r.id) ? { id: str(r.id) ?? "", title: str(r.title) } : null,
    ),
    listPaged(client, "/v1/workflows", 200, (r) =>
      str(r.id) ? { id: str(r.id) ?? "", slug: str(r.slug) } : null,
    ),
    listPaged(client, "/v1/connectors", 1000, (r) =>
      str(r.id) ? { id: str(r.id) ?? "", slug: str(r.slug) } : null,
    ),
  ]);
  return { conversations, workflows, connectors };
}

async function main(): Promise<void> {
  const parsed = parseSweepArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    if (parsed.error) console.error(parsed.error);
    console.error(usageText());
    process.exit(2);
  }
  const { args } = parsed;
  const client = createEngineClient(args.engine_url, process.env.SK_API_KEY ?? "");
  const listing = await listSweepCandidates(client);
  const plan = sweepPlan(listing, {
    titlePrefix: EVAL_LIVE_TITLE_PREFIX,
    workflowSlugs: args.workflowSlugs,
    connectorSlugs: args.connectorSlugs,
  });
  console.log(`live-sweep → ${args.engine_url}`);
  console.log(renderSweepTable(plan));
  console.log("");
  if (!args.yes) {
    console.log(`dry run: ${plan.length} artifact(s) would be deleted; pass --yes to delete`);
    process.exit(0);
  }
  const result = await deleteArtifacts(client, plan);
  console.log(`deleted ${result.deleted.length}/${plan.length}`);
  for (const failure of result.failures) console.log(`failure: ${failure}`);
  process.exit(result.failures.length === 0 ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
