import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type {
  ConnectorEndpointCandidate,
  ConnectorEndpointCandidateEnvelope,
  PotentialConnection,
} from "../../conversations/tools/discover-systems-from-files.ts";
import type { Db } from "../../db/client.ts";
import { knowledgeChunks, knowledgeSources } from "../../db/schema/knowledge_sources.ts";
import { logger } from "../../logging/logger.ts";
import { computeConfidence, type PatternSignal } from "../types.ts";

const CANDIDATES_SOURCE_TYPE = "connector_endpoint_candidates" as const;

interface ChainSignalKey {
  from_system: string;
  to_system: string;
  data_type: string;
}

interface ChainAggregate {
  key: ChainSignalKey;
  occurrences: number;
  evidence_source_ids: Set<string>;
  latest_evidence: string;
  from_candidate: ConnectorEndpointCandidate | undefined;
  to_candidate: ConnectorEndpointCandidate | undefined;
}

function chainKey(c: PotentialConnection): string {
  return `${c.from_system.toLowerCase()}::${c.to_system.toLowerCase()}::${c.data_type
    .toLowerCase()
    .trim()}`;
}

function findCandidate(
  candidates: ConnectorEndpointCandidate[],
  name: string,
): ConnectorEndpointCandidate | undefined {
  const lower = name.toLowerCase();
  return candidates.find((c) => c.name.toLowerCase() === lower);
}

export async function detectChainedWorkflowPatterns(
  tenant_id: string,
  exec: Db,
): Promise<PatternSignal[]> {
  const sourceRows = await exec
    .select()
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.tenant_id, tenant_id),
        eq(knowledgeSources.source_type, CANDIDATES_SOURCE_TYPE),
      ),
    );

  if (sourceRows.length === 0) {
    logger.debug({
      module: "skill",
      action: "detector.chained_workflow.no_envelopes",
      msg: "no candidate envelopes to scan",
      tenant_id,
    });
    return [];
  }

  const aggregate = new Map<string, ChainAggregate>();

  for (const src of sourceRows) {
    const chunks = await exec
      .select()
      .from(knowledgeChunks)
      .where(
        and(
          eq(knowledgeChunks.tenant_id, tenant_id),
          eq(knowledgeChunks.knowledge_source_id, src.id),
        ),
      )
      .limit(1);
    const chunk = chunks[0];
    if (!chunk?.content) continue;
    let envelope: ConnectorEndpointCandidateEnvelope;
    try {
      envelope = JSON.parse(chunk.content) as ConnectorEndpointCandidateEnvelope;
    } catch {
      continue;
    }
    const candidates = envelope.candidates ?? [];
    const connections = envelope.potential_connections ?? [];
    for (const conn of connections) {
      if (!conn.from_system || !conn.to_system || !conn.data_type) continue;
      const key = chainKey(conn);
      const prior = aggregate.get(key);
      const evidenceText =
        conn.evidence ?? `${conn.from_system} → ${conn.to_system} (${conn.data_type})`;
      const fromCandidate = findCandidate(candidates, conn.from_system);
      const toCandidate = findCandidate(candidates, conn.to_system);
      if (prior) {
        prior.occurrences += 1;
        prior.evidence_source_ids.add(src.id);
        prior.latest_evidence = evidenceText;
        if (!prior.from_candidate && fromCandidate) prior.from_candidate = fromCandidate;
        if (!prior.to_candidate && toCandidate) prior.to_candidate = toCandidate;
      } else {
        aggregate.set(key, {
          key: {
            from_system: conn.from_system,
            to_system: conn.to_system,
            data_type: conn.data_type,
          },
          occurrences: 1,
          evidence_source_ids: new Set([src.id]),
          latest_evidence: evidenceText,
          from_candidate: fromCandidate,
          to_candidate: toCandidate,
        });
      }
    }
  }

  if (aggregate.size === 0) {
    logger.debug({
      module: "skill",
      action: "detector.chained_workflow.no_connections",
      msg: "envelopes carry no potential_connections",
      tenant_id,
      envelopes_scanned: sourceRows.length,
    });
    return [];
  }

  const signals: PatternSignal[] = [];
  for (const agg of aggregate.values()) {
    const fromDriver = agg.from_candidate?.kind ?? "unknown";
    const toDriver = agg.to_candidate?.kind ?? "unknown";
    const fromRole = agg.from_candidate?.data_flow_role ?? "unknown";
    const toRole = agg.to_candidate?.data_flow_role ?? "unknown";
    const fromCapsList = agg.from_candidate?.capabilities ?? [];
    const toCapsList = agg.to_candidate?.capabilities ?? [];
    const fromCaps = fromCapsList.join(", ") || "(none stated)";
    const toCaps = toCapsList.join(", ") || "(none stated)";
    const sourceRead = fromCapsList.includes("read") || fromRole === "source";
    const destWrite = toCapsList.includes("write") || toRole === "destination";
    const aligned = sourceRead && destWrite;

    const fingerprint = createHash("sha256")
      .update(
        `chained_workflow:${agg.key.from_system}:${agg.key.to_system}:${agg.key.data_type}`.toLowerCase(),
      )
      .digest("hex")
      .slice(0, 32);

    const consistency = aligned ? 1.0 : 0.5;
    const confidence = computeConfidence(agg.evidence_source_ids.size, consistency);

    const body = [
      `Discovery surfaced a recurring data flow: **${agg.key.from_system}** (${fromDriver}, role=${fromRole}) → **${agg.key.to_system}** (${toDriver}, role=${toRole}) carrying \`${agg.key.data_type}\`.`,
      "",
      `Source capabilities: ${fromCaps}.`,
      `Destination capabilities: ${toCaps}.`,
      "",
      aligned
        ? "Capability alignment is clean (source can read, destination can write) — this is a textbook starting point for `author_workflow` chains."
        : "Capability alignment is partial — the operator may need to refine the role classification before authoring a workflow.",
      "",
      `Evidence: ${agg.latest_evidence}`,
    ].join("\n");

    signals.push({
      pattern_kind: "chained_workflow_pattern",
      scope: "global",
      title: `Chain ${agg.key.from_system} → ${agg.key.to_system} (${agg.key.data_type})`,
      body,
      examples: [
        `Step 1: read ${agg.key.data_type} from ${agg.key.from_system}.`,
        `Step 2: transform / map fields as needed.`,
        `Step 3: write ${agg.key.data_type} to ${agg.key.to_system}.`,
      ],
      best_practices: [
        "Bind concrete connectors before authoring the workflow — the chain is a template.",
        "Add `idempotency_key` on the destination write so retries don't double-create records.",
      ],
      pitfalls: [
        "Discovery is provisional — verify capability claims via `test_connector` before persisting.",
      ],
      doc_refs: [],
      fingerprint,
      confidence,
      evidence: [...agg.evidence_source_ids].slice(0, 50).map((id) => ({
        evidence_type: "discovery_envelope",
        summary: `Connection mentioned in knowledge_source ${id}: ${agg.latest_evidence}`,
      })),
    });
  }

  logger.debug({
    module: "skill",
    action: "detector.chained_workflow.result",
    msg: "chained-workflow detector finished",
    tenant_id,
    envelopes_scanned: sourceRows.length,
    signals_found: signals.length,
  });
  return signals;
}
