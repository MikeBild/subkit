import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { DiscoveredEndpoint, DiscoveryResult } from "../connectors/discovery/types.ts";
import type { Executor } from "../db/client.ts";
import { connectors as connectorsTable, workflowExecutionAuthorities } from "../db/schema/index.ts";
import { fitShapeSummary } from "../llm/core/context-assembler/formatters.ts";
import { type GenerationNeed, isUserNeed } from "../llm/core/generation-abort.ts";
import { logger } from "../logging/logger.ts";
import { listLatestShapes } from "../schema-versions/service.ts";
import type { SchemaShape } from "../self-healing/types.ts";

export const REGROUND_ROUTE_CAP = 120;
const REGROUND_PINNED_ROUTES_MAX = 8;
const REGROUND_SCHEMA_CAP_CHARS = 1_500;
const REGROUND_SHAPE_CAP_CHARS = 2_400;
const REGROUND_SHAPE_SCAN = 100;
const CHOICE_OPTIONS_MAX = 7;
const AUTHORITY_SCAN = 500;

export interface RegroundConnector {
  id: string;
  slug: string;
  base_url: string | null;
}

export interface RegroundPlan {
  pins: Map<string, DiscoveredEndpoint[]>;
  caps: Map<string, number>;
  targets: Array<{ connector: RegroundConnector; need: GenerationNeed }>;
  outOfScope: GenerationNeed[];
  unresolved: GenerationNeed[];
}

export interface RecordedShapeEvidence {
  connector_slug: string;
  endpoint_key: string;
  shape: SchemaShape;
}

function normalizeRoute(path: string): string[] {
  const bare = path.split(/[?#]/u)[0] ?? "";
  return bare
    .trim()
    .toLowerCase()
    .replace(/\/+$/u, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) =>
      /^\{[^}]*\}$/u.test(segment) || /^:[a-z0-9_]+$/u.test(segment) || /^\$\{.*\}$/u.test(segment)
        ? "*"
        : segment,
    );
}

function segmentsMatch(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((segment, i) => {
    const other = right[i];
    return segment === "*" || other === "*" || segment === other;
  });
}

export function routeMatches(documented: string, requested: string): boolean {
  const doc = normalizeRoute(documented);
  const req = normalizeRoute(requested);
  if (req.length === 0) return false;
  if (segmentsMatch(doc, req)) return true;
  if (doc.length > req.length) return segmentsMatch(doc.slice(doc.length - req.length), req);
  if (req.length > doc.length) return segmentsMatch(doc, req.slice(req.length - doc.length));
  return false;
}

function isEndpointNeed(need: GenerationNeed): boolean {
  return need.kind === "endpoint_contract" || need.kind === "response_shape";
}

export function planRegrounding(args: {
  needs: ReadonlyArray<GenerationNeed>;
  connectors: ReadonlyArray<RegroundConnector>;
  discoveredById: ReadonlyMap<string, DiscoveryResult>;
  excerptCap: number;
}): RegroundPlan {
  const plan: RegroundPlan = {
    pins: new Map(),
    caps: new Map(),
    targets: [],
    outOfScope: [],
    unresolved: [],
  };
  for (const need of args.needs) {
    if (!isEndpointNeed(need)) continue;
    let scoped: RegroundConnector[];
    if (need.connector_slug) {
      const named = args.connectors.find(
        (c) => c.slug === need.connector_slug || c.id === need.connector_slug,
      );
      if (!named) {
        plan.outOfScope.push(need);
        continue;
      }
      scoped = [named];
    } else {
      scoped = [...args.connectors];
    }
    let found = false;
    for (const connector of scoped) {
      plan.targets.push({ connector, need });
      const index = args.discoveredById.get(connector.id);
      if (!index || index.endpoints.length === 0) continue;
      if (!need.path) {
        if (index.endpoints.length > args.excerptCap) {
          plan.caps.set(connector.id, REGROUND_ROUTE_CAP);
          found = true;
        }
        continue;
      }
      const requested = need.path;
      const matches = index.endpoints.filter(
        (e) =>
          (need.method === null || e.method.toUpperCase() === need.method) &&
          routeMatches(e.path, requested),
      );
      if (matches.length === 0) continue;
      const pinned = plan.pins.get(connector.id) ?? [];
      for (const m of matches) {
        if (!pinned.includes(m) && pinned.length < REGROUND_PINNED_ROUTES_MAX) pinned.push(m);
      }
      plan.pins.set(connector.id, pinned);
      found = true;
    }
    if (!found) plan.unresolved.push(need);
  }
  return plan;
}

export async function loadRecordedShapesForNeeds(
  db: Executor,
  tenant_id: string,
  targets: RegroundPlan["targets"],
): Promise<RecordedShapeEvidence[]> {
  const byConnector = new Map<string, { connector: RegroundConnector; needs: GenerationNeed[] }>();
  for (const { connector, need } of targets) {
    if (!need.path) continue;
    const entry = byConnector.get(connector.id) ?? { connector, needs: [] };
    entry.needs.push(need);
    byConnector.set(connector.id, entry);
  }
  const out: RecordedShapeEvidence[] = [];
  for (const { connector, needs } of byConnector.values()) {
    const shapes = await listLatestShapes(
      { tenant_id, connector_id: connector.id, max_endpoints: REGROUND_SHAPE_SCAN },
      db,
    );
    for (const s of shapes) {
      const [method, ...rest] = s.endpoint_key.split(" ");
      const keyPath = rest.join(" ");
      const wanted = needs.some(
        (need) =>
          need.path !== null &&
          (need.method === null || need.method === method?.toUpperCase()) &&
          routeMatches(keyPath, need.path),
      );
      if (wanted) {
        out.push({ connector_slug: connector.slug, endpoint_key: s.endpoint_key, shape: s.shape });
      }
    }
  }
  return out;
}

function cappedJson(value: unknown, cap: number): string | null {
  if (value === null || value === undefined) return null;
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? "";
  } catch {
    return null;
  }
  if (rendered === "" || rendered === "{}") return null;
  return rendered.length > cap ? `${rendered.slice(0, cap)}…` : rendered;
}

export function formatRegroundedEvidence(args: {
  connectors: ReadonlyArray<RegroundConnector>;
  pins: ReadonlyMap<string, DiscoveredEndpoint[]>;
  shapes: ReadonlyArray<RecordedShapeEvidence>;
  raisedCapSlugs: ReadonlyArray<string>;
}): string | null {
  const lines: string[] = [];
  for (const c of args.connectors) {
    for (const e of args.pins.get(c.id) ?? []) {
      lines.push(`### \`${c.slug}\` ${e.method} ${e.path}`);
      const text = [e.summary, e.description].filter((t): t is string => !!t).join(" — ");
      if (text) lines.push(`- ${text.replace(/\s+/g, " ").trim()}`);
      if (e.params.length > 0) {
        lines.push(
          `- parameters: ${e.params
            .map(
              (p) =>
                `${p.name} (${p.in}${p.required ? ", required" : ""}${p.type ? `, ${p.type}` : ""})`,
            )
            .join("; ")}`,
        );
      }
      const body = cappedJson(e.request_body_schema, REGROUND_SCHEMA_CAP_CHARS);
      if (body)
        lines.push(
          `- request body${e.request_content_type ? ` [${e.request_content_type}]` : ""}: ${body}`,
        );
      const success = Object.entries(e.response_schemas).find(([status]) => /^2/u.test(status));
      const response = success ? cappedJson(success[1], REGROUND_SCHEMA_CAP_CHARS) : null;
      if (success && response) lines.push(`- response ${success[0]}: ${response}`);
      if (e.pagination_hint?.kind) {
        lines.push(
          `- pagination: ${e.pagination_hint.kind} (${e.pagination_hint.param_names.join(", ")})`,
        );
      }
    }
  }
  for (const s of args.shapes) {
    const summary = fitShapeSummary(s.shape, REGROUND_SHAPE_CAP_CHARS);
    lines.push(`- recorded response \`${s.connector_slug}\` ${s.endpoint_key}: ${summary}`);
  }
  if (args.raisedCapSlugs.length > 0) {
    lines.push(
      `- The discovered-endpoint list above now carries up to ${REGROUND_ROUTE_CAP} routes for ${args.raisedCapSlugs.map((s) => `\`${s}\``).join(", ")}.`,
    );
  }
  if (lines.length === 0) return null;
  return [
    "## Evidence fetched for the previous abort — exact operation contracts",
    "The previous attempt aborted for missing evidence. The engine looked it up in the connector's discovery index and recorded responses. Use these contracts verbatim; abort again only for a fact that is still absent.",
    ...lines,
  ].join("\n");
}

export interface ConnectorChoiceCandidate {
  id: string;
  slug: string;
  display_name: string;
  environment: "dev" | "prod";
  active_prod_approvals: number;
}

export interface UserPromptPayload {
  tool: "ask_user_choice" | "ask_user_text";
  args: Record<string, unknown>;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function candidateScore(c: ConnectorChoiceCandidate): number {
  return (c.environment === "prod" ? 2 : 0) + (c.active_prod_approvals > 0 ? 1 : 0);
}

export function rankConnectorCandidates(candidates: ReadonlyArray<ConnectorChoiceCandidate>): {
  ordered: ConnectorChoiceCandidate[];
  default: string | null;
} {
  const ordered = [...candidates].sort(
    (a, b) => candidateScore(b) - candidateScore(a) || a.slug.localeCompare(b.slug),
  );
  const top = ordered[0];
  const second = ordered[1];
  const topScore = top ? candidateScore(top) : 0;
  const unique = top !== undefined && (second === undefined || candidateScore(second) < topScore);
  return { ordered, default: unique && topScore > 0 && top ? top.slug : null };
}

function describeCandidate(c: ConnectorChoiceCandidate): string {
  const approvals =
    c.active_prod_approvals > 0
      ? `${c.active_prod_approvals} active production approval(s)`
      : "no active production approval";
  return clip(`environment ${c.environment} · ${approvals}`, 180);
}

export function buildUserPrompt(args: {
  needs: ReadonlyArray<GenerationNeed>;
  candidates: ReadonlyArray<ConnectorChoiceCandidate>;
  reason: string;
}): UserPromptPayload {
  const choice = args.needs.find((n) => n.kind === "connector_choice");
  if (choice && args.candidates.length >= 2) {
    const ranked = rankConnectorCandidates(args.candidates);
    const options = ranked.ordered.slice(0, CHOICE_OPTIONS_MAX).map((c) => ({
      value: c.slug,
      label: clip(c.display_name || c.slug, 80),
      description: describeCandidate(c),
    }));
    const defaultValue =
      ranked.default && options.some((o) => o.value === ranked.default) ? ranked.default : null;
    return {
      tool: "ask_user_choice",
      args: {
        question: clip(choice.question ?? "Which connector should this workflow use?", 240),
        options,
        ...(defaultValue ? { default: defaultValue } : {}),
      },
    };
  }
  const questions = args.needs
    .filter(isUserNeed)
    .map(
      (n) =>
        n.question ??
        (n.connector_slug ? `Which connector replaces \`${n.connector_slug}\`?` : null),
    )
    .filter((q): q is string => q !== null);
  return {
    tool: "ask_user_text",
    args: {
      question: questions.length > 0 ? questions.join("\n") : args.reason,
      ...(questions.length > 1 ? { multiline: true } : {}),
    },
  };
}

function hostOf(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return null;
  }
}

export async function loadConnectorChoiceCandidates(
  db: Executor,
  tenant_id: string,
  args: { needs: ReadonlyArray<GenerationNeed>; inScope: ReadonlyArray<RegroundConnector> },
): Promise<ConnectorChoiceCandidate[]> {
  const rows = await db
    .select({
      id: connectorsTable.id,
      slug: connectorsTable.slug,
      display_name: connectorsTable.display_name,
      driver: connectorsTable.driver,
      base_url: connectorsTable.base_url,
      environment: connectorsTable.environment,
    })
    .from(connectorsTable)
    .where(eq(connectorsTable.tenant_id, tenant_id));
  const named = new Set(
    args.needs.map((n) => n.connector_slug).filter((s): s is string => s !== null),
  );
  const anchors = rows.filter(
    (r) => named.has(r.slug) || named.has(r.id) || args.inScope.some((c) => c.id === r.id),
  );
  const anchorFamilies = new Set(anchors.map((a) => `${a.driver}|${hostOf(a.base_url) ?? a.slug}`));
  const family = rows.filter(
    (r) =>
      anchors.some((a) => a.id === r.id) ||
      anchorFamilies.has(`${r.driver}|${hostOf(r.base_url) ?? r.slug}`),
  );
  if (family.length === 0) return [];
  const approvals = await countActiveProdApprovals(db, tenant_id, new Set(family.map((r) => r.id)));
  return family.map((r) => ({
    id: r.id,
    slug: r.slug,
    display_name: r.display_name,
    environment: r.environment,
    active_prod_approvals: approvals.get(r.id) ?? 0,
  }));
}

async function countActiveProdApprovals(
  db: Executor,
  tenant_id: string,
  connectorIds: ReadonlySet<string>,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ effect_manifest: workflowExecutionAuthorities.effect_manifest })
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, tenant_id),
        eq(workflowExecutionAuthorities.execution_environment, "prod"),
        isNull(workflowExecutionAuthorities.revoked_at),
        or(
          isNull(workflowExecutionAuthorities.valid_until),
          gt(workflowExecutionAuthorities.valid_until, sql`now()`),
        ),
      ),
    )
    .limit(AUTHORITY_SCAN);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const bindings = (row.effect_manifest as { bindings?: unknown }).bindings;
    if (!Array.isArray(bindings)) continue;
    const seen = new Set<string>();
    for (const binding of bindings) {
      const id = (binding as { connector_id?: unknown } | null)?.connector_id;
      if (typeof id === "string" && connectorIds.has(id)) seen.add(id);
    }
    for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export function nextActionsForNeeds(
  needs: ReadonlyArray<GenerationNeed>,
  userPrompt: UserPromptPayload | null,
): string[] {
  const actions: string[] = [];
  const add = (name: string) => {
    if (!actions.includes(name)) actions.push(name);
  };
  if (userPrompt) add(userPrompt.tool);
  for (const need of needs) {
    if (need.kind === "endpoint_contract") {
      add("discover_connector_endpoints");
      add("fetch_connector_docs");
    } else if (need.kind === "response_shape") {
      add("probe_connector");
    } else if (need.kind === "connector_choice" && !userPrompt) {
      add("find_connector");
    }
  }
  add("author_workflow");
  return actions;
}

export type GenerationAbortOutcome =
  | { kind: "needs_user"; needs: GenerationNeed[]; userPrompt: UserPromptPayload }
  | { kind: "unresolved" }
  | { kind: "regrounded"; evidence: string; plan: RegroundPlan };

export async function resolveGenerationAbort(args: {
  ctx: {
    db: Executor;
    tenant_id: string;
    conversation_id?: string | undefined;
    onLog?: ((level: "debug" | "info" | "warn" | "error", message: string) => void) | undefined;
  };
  abort: { reason: string; needs: GenerationNeed[] };
  pass: number;
  connectors: ReadonlyArray<RegroundConnector>;
  discoveredById: ReadonlyMap<string, DiscoveryResult>;
  excerptCap: number;
  canReground: boolean;
  alreadyRegrounded: boolean;
}): Promise<GenerationAbortOutcome> {
  const { ctx, abort, pass, connectors } = args;
  const plan = planRegrounding({
    needs: abort.needs,
    connectors,
    discoveredById: args.discoveredById,
    excerptCap: args.excerptCap,
  });
  const userNeeds: GenerationNeed[] = [
    ...abort.needs.filter(isUserNeed),
    ...plan.outOfScope.map((need) => ({
      ...need,
      kind: "connector_choice" as const,
      question:
        need.question ??
        `The draft needs \`${need.connector_slug}\`, which this authoring call was not given. Which connector should it use?`,
    })),
  ];
  if (userNeeds.length > 0) {
    const candidates = await loadConnectorChoiceCandidates(ctx.db, ctx.tenant_id, {
      needs: userNeeds,
      inScope: connectors,
    });
    const userPrompt = buildUserPrompt({ needs: userNeeds, candidates, reason: abort.reason });
    logger.info({
      module: "conversations",
      action: "authoring_pipeline.abort_needs_user",
      msg: "generation aborted on a fact only the user can decide — handing a prefilled question to the outer agent",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      pass,
      need_kinds: abort.needs.map((n) => n.kind),
      prompt_tool: userPrompt.tool,
    });
    ctx.onLog?.("warn", `generate · aborted — the user must decide: ${abort.reason}`);
    return {
      kind: "needs_user",
      needs: [...userNeeds, ...abort.needs.filter((n) => !isUserNeed(n))],
      userPrompt,
    };
  }
  const shapes = args.canReground
    ? await loadRecordedShapesForNeeds(ctx.db, ctx.tenant_id, plan.targets)
    : [];
  const raisedCapSlugs = connectors.filter((c) => plan.caps.has(c.id)).map((c) => c.slug);
  const evidence = args.canReground
    ? formatRegroundedEvidence({ connectors, pins: plan.pins, shapes, raisedCapSlugs })
    : null;
  if (!evidence) {
    logger.info({
      module: "conversations",
      action: "authoring_pipeline.abort_unresolved",
      msg: "generation aborted for evidence the engine cannot find — returning the needs to the outer agent instead of an identical retry",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      pass,
      already_regrounded: args.alreadyRegrounded,
      need_kinds: abort.needs.map((n) => n.kind),
    });
    return { kind: "unresolved" };
  }
  const pinnedCount = [...plan.pins.values()].reduce((acc, list) => acc + list.length, 0);
  logger.info({
    module: "conversations",
    action: "authoring_pipeline.regrounded",
    msg: "generation aborted for missing evidence — re-grounded the named routes and recorded shapes for one more pass",
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    pass,
    pinned_routes: pinnedCount,
    recorded_shapes: shapes.length,
    raised_caps: raisedCapSlugs.length,
    unresolved_needs: plan.unresolved.length,
  });
  ctx.onLog?.(
    "info",
    `ground · re-grounded ${pinnedCount} route(s) and ${shapes.length} recorded shape(s) named by the abort`,
  );
  return { kind: "regrounded", evidence, plan };
}
