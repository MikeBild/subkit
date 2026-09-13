// discover_systems_from_files — fallback when the OpenAPI / introspection
// chain returns nothing usable. The operator uploads a README, an
// architecture document, a code dump, etc. as a knowledge source; this
// tool asks Claude (via the `extract` flow) to enumerate the third-party
// systems it can identify, with provisional endpoints, auth shapes, and
// data-flow notes the operator can refine into real connectors.
//
// Why this exists. Wave-1 discovery handles "the API has a spec" — it
// fails closed when the vendor doesn't publish one. Without a fallback
// the agent had to give up or invent endpoints from training-data
// memory (which is what surfaced the original session-00b93a52 bug
// against DigitalOcean for endpoints discovery: hallucinated routes,
// 404 cascades, ~216 K tokens burned). This tool keeps the agent on the
// ingestion-driven path even when the spec is missing — the LLM is
// reading actual operator-supplied text, not training data.
//
// Caching contract. The result is persisted as a `knowledge_sources` row
// with `source_type = "connector_endpoint_candidates"` (free-form text
// column on the schema, no migration). Slug is keyed off the source
// upload's id so a repeat call against the same source within the 24h
// freshness window returns the cached candidates instead of re-paying
// for an LLM call. The single chunk holds the JSON envelope; the
// existing chunk pipeline (audit, dedup, search) stays consistent with
// how `discover_connector_endpoints` persists its index.

import { createHash } from "node:crypto";

import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";

import { recordKnowledgeSourceCandidatesSynthesized } from "../../audit/recorders/index.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import { knowledgeChunks, knowledgeSources } from "../../db/schema/knowledge_sources.ts";
import { invoke } from "../../llm/core/invoke.ts";
import { logger } from "../../logging/logger.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

/** 24h freshness window — matches the discovery cache window so the two
 *  fallback paths feel symmetric to operators. */
export const CANDIDATES_TTL_MS = 24 * 60 * 60 * 1000;

/** Hard cap on the source content the LLM analyses. Anything beyond this
 *  is refused with `knowledge_source_too_large` — operators are pointed
 *  at `fetch_connector_docs` instead (which has its own targeted-snippet
 *  pipeline). 100 KB is roughly 25 K tokens, well inside the converse
 *  context budget but a lot of money per call. */
export const KNOWLEDGE_SOURCE_MAX_CHARS = 100_000;

/** Free-form `knowledge_sources.source_type` discriminator. */
const SOURCE_TYPE = "connector_endpoint_candidates" as const;

const inputSchema = z
  .object({
    knowledge_source_id: z.string().uuid(),
  })
  .openapi("DiscoverSystemsFromFilesToolInput");

type DiscoverSystemsFromFilesArgs = z.infer<typeof inputSchema>;

/**
 * What the candidate system *does* — used for chained-workflow proposals.
 *
 *   - source         — emits records, the subkit tenant reads them.
 *   - destination    — accepts records, the tenant writes to it.
 *   - bidirectional  — read + write are both expected.
 *   - processing     — neutral compute (transform, enrichment), no
 *                      durable state of its own.
 */
const DataFlowRoleEnum = z.enum(["source", "destination", "bidirectional", "processing"]);

/**
 * Capability fingerprint — a compact set of verbs the candidate
 * supports. Drives the chained-workflow detector: a `source` with
 * `read` chained to a `destination` with `write` is a textbook
 * workflow seed. The set is deliberately small so the LLM emits
 * stable, comparable values across files.
 */
const CapabilityEnum = z.enum([
  "read",
  "write",
  "search",
  "stream",
  "webhook",
  "subscribe",
  "transform",
]);

const CandidateSchema = z.object({
  name: z.string(),
  /**
   * Four drivers, not five. `mcp` is deliberately absent: this enum is
   * what the model may infer FROM A FILE, and no file artifact identifies
   * an MCP server the way an OpenAPI document identifies an HTTP API or a
   * DSN identifies a database. Offering the value without such a marker
   * buys guesses, not discoveries. Widen it when a spec-shaped artifact
   * exists to ground the choice — not to make the list symmetric with
   * `DriverName`.
   */
  kind: z.enum(["http", "graphql", "postgres", "s3"]),
  base_url_guess: z.string().nullable(),
  endpoints: z.array(
    z.object({
      method: z.string(),
      path: z.string(),
      summary: z.string(),
    }),
  ),
  auth_kind: z.enum(["none", "header", "query", "bearer", "basic", "oauth2", "unknown"]),
  /** One short sentence describing how the operator's tenant exchanges
   *  data with this system. Operators read this verbatim — keep prose. */
  data_flow_summary: z.string(),
  /** Structured complement to the prose: source / destination / both. */
  data_flow_role: DataFlowRoleEnum,
  /** Verbs the candidate supports. May be empty when unstated. */
  capabilities: z.array(CapabilityEnum).default([]),
});

/**
 * Edge between two candidates extracted from the same file set —
 * "Stripe charges flow into HubSpot deals", "Salesforce contacts feed
 * into Mailchimp lists". The downstream `chained-workflow-pattern`
 * skill-candidate detector reads this graph to seed workflow
 * proposals without a second LLM round-trip.
 */
const PotentialConnectionSchema = z.object({
  from_system: z.string(),
  to_system: z.string(),
  /** Free-form noun for the payload (e.g. "charges", "deals", "user
   *  events"). Operators read it; the detector just hashes it. */
  data_type: z.string(),
  direction: z.enum(["one_way", "bidirectional"]).default("one_way"),
  /** Optional rationale excerpted from the source. */
  evidence: z.string().nullable().default(null),
});

const CandidateEnvelopeSchema = z.object({
  candidates: z.array(CandidateSchema),
  /** Inferred connections between the candidates above. May be empty. */
  potential_connections: z.array(PotentialConnectionSchema).default([]),
});

export type ConnectorEndpointCandidate = z.infer<typeof CandidateSchema>;
export type ConnectorEndpointCandidateEnvelope = z.infer<typeof CandidateEnvelopeSchema>;
export type DataFlowRole = z.infer<typeof DataFlowRoleEnum>;
export type CandidateCapability = z.infer<typeof CapabilityEnum>;
export type PotentialConnection = z.infer<typeof PotentialConnectionSchema>;

interface CachedCandidates {
  candidates: ConnectorEndpointCandidate[];
  potential_connections: PotentialConnection[];
  cached_at: string;
  cache_row_id: string;
}

function isFresh(last_refreshed_at: Date | null): boolean {
  if (!last_refreshed_at) return false;
  const age = Date.now() - last_refreshed_at.getTime();
  return age >= 0 && age < CANDIDATES_TTL_MS;
}

function deriveSlug(source_id: string): string {
  const hash = createHash("sha256").update(source_id).digest("hex").slice(0, 16);
  return `endpoint-candidates-${hash}`.slice(0, 100);
}

export const discoverSystemsFromFilesTool: ConversationTool = {
  name: "discover_systems_from_files",
  description:
    "When the connector's API has no OpenAPI spec, fall back to analyzing an uploaded knowledge source (README, code, PDF, architecture doc) to synthesize provisional endpoints. Returns connector_endpoint_candidates: a list of {name, kind, base_url_guess, endpoints, auth_kind, data_flow_summary, data_flow_role, capabilities[]} plus a potential_connections[] graph between candidates so the agent can propose chained workflows without a second round-trip.",
  inputSchema,
  category: "tenant_read",
  // Builds a definition rather than using one: withheld from the
  // read-and-execute tier even though it only reads.
  authoring_only: true,
  use_case:
    "Reach for this when `discover_connector_endpoints` returns no endpoints and no text_corpus, but the operator has uploaded a description of the system (README, architecture doc, code dump). The LLM enumerates third-party systems and provisional endpoints from the file.",
  important_notes: [
    'Inputs are bounded: source content over 100 KB is refused with `error_code: "knowledge_source_too_large"` — point the operator at `fetch_connector_docs` instead.',
    'Cached per-tenant for 24h keyed on the source knowledge_source_id. A second call within the window returns `source: "cache"` and does NOT invoke the LLM.',
    "Output is provisional. Treat candidates as a starting point the operator must refine — do NOT auto-create connectors from them without confirmation.",
  ],
  example_input: { knowledge_source_id: "00000000-0000-0000-0000-000000000000" },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs) as DiscoverSystemsFromFilesArgs;

    logger.info({
      module: "conversation_tool",
      action: "discover_systems_from_files.started",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      source_id: args.knowledge_source_id,
    });

    // 1) Load the operator-supplied knowledge source. Tenant-scoped.
    const sourceRows = await ctx.db
      .select()
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.tenant_id, ctx.tenant_id),
          eq(knowledgeSources.id, args.knowledge_source_id),
        ),
      )
      .limit(1);
    const sourceRow = sourceRows[0];
    if (!sourceRow) {
      logger.warn({
        module: "conversation_tool",
        action: "discover_systems_from_files.source_not_found",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        source_id: args.knowledge_source_id,
      });
      return {
        ok: false,
        error_code: "knowledge_source_not_found",
        message: `No knowledge source found with id ${args.knowledge_source_id} for this tenant.`,
        next_best_actions: ["list_attachments", "ask_user"],
      };
    }

    // 2) Idempotency — return the cached candidates row if it's fresh.
    const slug = deriveSlug(args.knowledge_source_id);
    const cached = await readCachedCandidates(ctx.db, ctx.tenant_id, slug);
    if (cached) {
      logger.info({
        module: "conversation_tool",
        action: "discover_systems_from_files.cached",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        source_id: args.knowledge_source_id,
        candidate_count: cached.candidates.length,
      });
      return {
        ok: true,
        data: {
          source: "cache",
          candidates: cached.candidates,
          potential_connections: cached.potential_connections,
          cached_at: cached.cached_at,
        },
      };
    }

    // 3) Pull the source's chunks back into a single content blob.
    const chunkRows = await ctx.db
      .select()
      .from(knowledgeChunks)
      .where(
        and(
          eq(knowledgeChunks.tenant_id, ctx.tenant_id),
          eq(knowledgeChunks.knowledge_source_id, args.knowledge_source_id),
        ),
      );
    const orderedChunks = [...chunkRows].sort((a, b) => a.ordinal - b.ordinal);
    const content = orderedChunks.map((c) => c.content).join("\n\n");

    if (content.length === 0) {
      return {
        ok: false,
        error_code: "knowledge_source_empty",
        message: `Knowledge source ${args.knowledge_source_id} has no parsed chunks.`,
        next_best_actions: ["ask_user", "fetch_connector_docs"],
      };
    }

    if (content.length > KNOWLEDGE_SOURCE_MAX_CHARS) {
      logger.warn({
        module: "conversation_tool",
        action: "discover_systems_from_files.too_large",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        source_id: args.knowledge_source_id,
        size: content.length,
        limit: KNOWLEDGE_SOURCE_MAX_CHARS,
      });
      return {
        ok: false,
        error_code: "knowledge_source_too_large",
        message: `Knowledge source content is ${content.length} chars (limit ${KNOWLEDGE_SOURCE_MAX_CHARS}). Use fetch_connector_docs for targeted snippets instead.`,
        next_best_actions: ["fetch_connector_docs"],
      };
    }

    // 4) Ask Claude to enumerate the systems described in the file
    //    plus the data-flow graph between them. The structured
    //    `data_flow_role` + `capabilities` complement the prose
    //    `data_flow_summary` and feed the chained-workflow detector.
    const userContent = [
      "Analyze the following document and enumerate every third-party system or API it describes.",
      "For each system, return:",
      "  - name: the operator-facing label (e.g. 'DigitalOcean', 'Stripe').",
      "  - kind: one of http | graphql | postgres | s3.",
      "  - base_url_guess: the most plausible base URL or null if unstated.",
      "  - endpoints: list of { method, path, summary } the document mentions or implies.",
      "  - auth_kind: one of none | header | query | bearer | basic | oauth2 | unknown.",
      "  - data_flow_summary: one short sentence describing how the operator's tenant exchanges data with this system.",
      "  - data_flow_role: one of source | destination | bidirectional | processing.",
      "      • source: the system emits records the tenant reads.",
      "      • destination: the system accepts records the tenant writes.",
      "      • bidirectional: both read and write are expected.",
      "      • processing: neutral compute / transform with no durable state.",
      "  - capabilities: array drawn from [read, write, search, stream, webhook, subscribe, transform]; may be empty when unstated.",
      "",
      "Then return potential_connections: an array of edges between systems",
      "the document implies. Each edge is {from_system, to_system, data_type, direction, evidence?}.",
      "Only emit an edge when the document literally describes data moving",
      "between the two systems — do NOT speculate. `direction` is 'one_way' unless a round-trip is explicit.",
      "",
      "Be conservative — do NOT invent endpoints, capabilities, or connections the document does not mention.",
      "If unsure, leave endpoints, capabilities, or potential_connections empty.",
      "",
      `## Source: ${sourceRow.source_uri}`,
      "```",
      content,
      "```",
    ].join("\n");

    const llm = await invoke<ConnectorEndpointCandidateEnvelope>(
      {
        flow: "extract",
        tenant_id: ctx.tenant_id,
        user_turns: [{ role: "user", content: userContent }],
        schema: CandidateEnvelopeSchema,
        telemetry_metadata: {
          tool: "discover_systems_from_files",
          source_id: args.knowledge_source_id,
        },
      },
      ctx.db,
    );

    const candidates = llm.object?.candidates ?? [];
    const potentialConnections = llm.object?.potential_connections ?? [];
    const endpointCount = candidates.reduce((sum, c) => sum + c.endpoints.length, 0);

    // 5) Persist the candidates + connection graph as a knowledge_sources
    //    row keyed off the source's id so subsequent calls within 24h
    //    hit the cache.
    const persisted = await persistCandidates(ctx, {
      slug,
      source_knowledge_source_id: args.knowledge_source_id,
      candidates,
      potential_connections: potentialConnections,
      source_uri: sourceRow.source_uri,
    });

    await recordKnowledgeSourceCandidatesSynthesized({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.actor_id,
      knowledge_source_id: persisted.row_id,
      source_knowledge_source_id: args.knowledge_source_id,
      candidate_count: candidates.length,
      endpoint_count: endpointCount,
      model_used: llm.model_used,
      reason: "file_analysis",
      created: persisted.created,
      executor: ctx.db,
    });

    logger.info({
      module: "conversation_tool",
      action: "discover_systems_from_files.fresh",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      source_id: args.knowledge_source_id,
      candidate_count: candidates.length,
      endpoint_count: endpointCount,
      model_used: llm.model_used,
    });

    return {
      ok: true,
      data: {
        source: "fresh",
        candidates,
        potential_connections: potentialConnections,
        cached_at: persisted.cached_at,
      },
    };
  },
};

async function readCachedCandidates(
  db: Parameters<ConversationTool["execute"]>[0]["db"],
  tenant_id: string,
  slug: string,
): Promise<CachedCandidates | null> {
  const rows = await db
    .select()
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.tenant_id, tenant_id), eq(knowledgeSources.slug, slug)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.source_type !== SOURCE_TYPE) return null;
  if (!isFresh(row.last_refreshed_at)) return null;
  const chunks = await db
    .select()
    .from(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.tenant_id, tenant_id),
        eq(knowledgeChunks.knowledge_source_id, row.id),
      ),
    )
    .limit(1);
  const chunk = chunks[0];
  if (!chunk) return null;
  try {
    const parsed = JSON.parse(chunk.content) as ConnectorEndpointCandidateEnvelope;
    return {
      candidates: parsed.candidates ?? [],
      potential_connections: parsed.potential_connections ?? [],
      cached_at: row.last_refreshed_at?.toISOString() ?? new Date().toISOString(),
      cache_row_id: row.id,
    };
  } catch {
    return null;
  }
}

async function persistCandidates(
  ctx: Parameters<ConversationTool["execute"]>[0],
  p: {
    slug: string;
    source_knowledge_source_id: string;
    candidates: ConnectorEndpointCandidate[];
    potential_connections: PotentialConnection[];
    source_uri: string;
  },
): Promise<{ row_id: string; cached_at: string; created: boolean }> {
  const envelope: ConnectorEndpointCandidateEnvelope = {
    candidates: p.candidates,
    potential_connections: p.potential_connections,
  };
  const json = JSON.stringify(envelope);
  const version = createHash("sha256").update(json).digest("hex").slice(0, 32);
  const bytes = Buffer.byteLength(json, "utf8");
  const now = new Date();
  const db = ctx.db;

  const existing = await db
    .select()
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.tenant_id, ctx.tenant_id), eq(knowledgeSources.slug, p.slug)))
    .limit(1);
  const prior = existing[0];

  if (prior) {
    await db
      .update(knowledgeSources)
      .set({
        source_type: SOURCE_TYPE,
        source_uri: p.source_knowledge_source_id,
        version,
        bytes_total: bytes,
        chunk_count: 1,
        last_refreshed_at: now,
        status: "active",
        updated_at: now,
      })
      .where(eq(knowledgeSources.id, prior.id));
    await db.delete(knowledgeChunks).where(eq(knowledgeChunks.knowledge_source_id, prior.id));
    await db.insert(knowledgeChunks).values({
      tenant_id: ctx.tenant_id,
      knowledge_source_id: prior.id,
      ordinal: 0,
      title: `Connector candidates for ${p.source_uri}`,
      path: p.source_knowledge_source_id,
      content: json,
      byte_size: bytes,
      fingerprint: version,
    });
    return { row_id: prior.id, cached_at: now.toISOString(), created: false };
  }

  const [inserted] = await db
    .insert(knowledgeSources)
    .values({
      tenant_id: ctx.tenant_id,
      name: `Endpoint candidates for ${p.source_uri}`,
      slug: p.slug,
      description: `Connector endpoint candidates synthesised from knowledge source ${p.source_knowledge_source_id}.`,
      scope: "global",
      workflow_id: null,
      status: "active",
      source_type: SOURCE_TYPE,
      source_uri: p.source_knowledge_source_id,
      mime_type: "application/json",
      version,
      bytes_total: bytes,
      chunk_count: 1,
      refresh_strategy: "manual",
      last_refreshed_at: now,
    })
    .returning();
  assertInsertRow(inserted, "knowledge_sources");
  await db.insert(knowledgeChunks).values({
    tenant_id: ctx.tenant_id,
    knowledge_source_id: inserted.id,
    ordinal: 0,
    title: `Connector candidates for ${p.source_uri}`,
    path: p.source_knowledge_source_id,
    content: json,
    byte_size: bytes,
    fingerprint: version,
  });
  return { row_id: inserted.id, cached_at: now.toISOString(), created: true };
}
