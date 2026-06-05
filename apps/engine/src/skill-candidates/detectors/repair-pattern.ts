// Repair Pattern Detector — accumulates recurring self-healing repairs into
// connector-scoped (interface-level) Skill Candidate signals.
//
// A single drift repair lands as one applied `patch_candidate`. When the SAME
// repair recurs across the SAME interface — a connector + endpoint pair — it is
// no longer an isolated fix: it is a standing convention about how that
// interface behaves. This detector promotes that recurrence into context that
// applies to EVERY workflow talking to the interface, not just the workflow
// where the patch happened to be observed.
//
// Input:        Applied patches for a tenant (last 30 days), joined to their
//               execution fixtures for connector + endpoint context.
// Grouping key: (connector_id, endpoint_key, patch kind)
// Threshold:    >= 3 patches in a group
// Output:       Connector-scoped PatternSignal (cross-workflow accumulation;
//               connector + endpoint context comes from execution_fixtures).
//
// Grouping is deliberately at interface altitude: the kind is grouped, the
// specific field path is NOT part of the key. Three `update_field_path`
// repairs on the same endpoint that touch different paths still form one
// "this interface needs field-path adjustment" convention. Because the path
// is not part of the group, candidate copy never names a specific path — that
// would misrepresent a group that may span several.
//
// Rows without an execution fixture (null fixture_id) carry no interface
// context and are skipped (counted). Rows whose diff lacks a PatchProposal are
// skipped (counted). The self-healing writer (processDriftSignal in
// self-healing/service.ts) nests the proposal under `diff.proposal`; `kind` is
// `proposal.kind`.

import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { and, eq, gte } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { connectors } from "../../db/schema/connectors.ts";
import { executionFixtures, patchCandidates } from "../../db/schema/executions.ts";
import { logger } from "../../logging/logger.ts";
import { now } from "../../utils/clock.ts";
import { computeConfidence, type PatternSignal } from "../types.ts";

const MIN_PATCH_COUNT = 3;
const LOOKBACK_DAYS = 30;

// Read-shape for the patch proposal the self-healing writer nests under
// `diff.proposal` (the producer is `processDriftSignal` in
// self-healing/service.ts, which stores a PatchProposal from
// llm/flows/repair.ts). This is an internal trust boundary — the writer is the
// only producer — but parsing it through a schema means a writer-side rename
// surfaces as a counted skip (`skipped_no_proposal`) instead of a silent
// misgroup, and keeps the read site honest about the field it depends on.
const RepairProposalReadSchema = z.object({
  kind: z.string(),
});

interface PatchGroup {
  connector_id: string;
  connector_slug: string | null;
  endpoint_key: string;
  kind: string;
  count: number;
  patch_ids: string[];
}

export async function detectRepairPatterns(tenant_id: string, exec: Db): Promise<PatternSignal[]> {
  const cutoff = new Date(now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  // Inner-join to execution_fixtures on BOTH fixture_id and tenant_id: the
  // tenant predicate keeps the read tenant-scoped (no cross-tenant fixture
  // reads), and the inner join naturally drops rows with a null fixture_id.
  // Left-join connectors (also tenant-scoped) for the human-readable slug:
  // the connector may have been deleted, so slug is best-effort and only used
  // for the candidate title — but the tenant predicate stops a mis-shaped
  // fixture from leaking another tenant's slug into a user-visible title.
  const rows = await exec
    .select({
      id: patchCandidates.id,
      diff: patchCandidates.diff,
      connector_id: executionFixtures.connector_id,
      endpoint_key: executionFixtures.endpoint_key,
      connector_slug: connectors.slug,
    })
    .from(patchCandidates)
    .innerJoin(
      executionFixtures,
      and(
        eq(patchCandidates.fixture_id, executionFixtures.id),
        eq(executionFixtures.tenant_id, tenant_id),
      ),
    )
    .leftJoin(
      connectors,
      and(eq(connectors.id, executionFixtures.connector_id), eq(connectors.tenant_id, tenant_id)),
    )
    .where(
      and(
        eq(patchCandidates.tenant_id, tenant_id),
        eq(patchCandidates.status, "applied"),
        gte(patchCandidates.created_at, cutoff),
      ),
    );

  let skipped_no_proposal = 0;
  let skipped_no_endpoint = 0;

  const groups = new Map<string, PatchGroup>();
  // Per-(connector, endpoint) total of applied patches that carry a proposal —
  // the denominator for the confidence consistency ratio at interface altitude.
  const totalsByInterface = new Map<string, number>();

  for (const row of rows) {
    const diff = row.diff as Record<string, unknown> | null;
    const parsed = RepairProposalReadSchema.safeParse(
      diff && typeof diff === "object" ? diff.proposal : undefined,
    );
    if (!parsed.success) {
      skipped_no_proposal++;
      continue;
    }

    const connector_id = row.connector_id;
    const endpoint_key = row.endpoint_key;
    if (!connector_id || !endpoint_key) {
      skipped_no_endpoint++;
      continue;
    }

    const kind = parsed.data.kind;

    const interfaceKey = `${connector_id}:${endpoint_key}`;
    totalsByInterface.set(interfaceKey, (totalsByInterface.get(interfaceKey) ?? 0) + 1);

    const key = `${connector_id}:${endpoint_key}:${kind}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      existing.patch_ids.push(row.id);
    } else {
      groups.set(key, {
        connector_id,
        connector_slug: row.connector_slug,
        endpoint_key,
        kind,
        count: 1,
        patch_ids: [row.id],
      });
    }
  }

  const signals: PatternSignal[] = [];

  for (const [, group] of groups) {
    if (group.count < MIN_PATCH_COUNT) continue;

    const interfaceKey = `${group.connector_id}:${group.endpoint_key}`;
    const totalForInterface = totalsByInterface.get(interfaceKey) ?? 0;
    const ratio = totalForInterface > 0 ? group.count / totalForInterface : 0;

    const fingerprint = createHash("sha256")
      .update(`repair:${group.connector_id}:${group.endpoint_key}:${group.kind}`)
      .digest("hex")
      .slice(0, 32);

    // Qualify the interface with the connector slug so two connectors that
    // expose the same endpoint_key don't produce visually identical titles.
    // Falls back to the connector id when the connector row is gone.
    const interfaceLabel = `${group.connector_slug ?? group.connector_id}/${group.endpoint_key}`;
    // The specific field path is intentionally absent: the group spans a kind
    // on an interface, possibly across several paths, so the copy stays at the
    // interface convention level rather than naming one path.
    const body =
      group.kind === "update_field_path"
        ? `Repairs on the '${interfaceLabel}' interface consistently adjust a response field path. This is an interface-level convention shared by every workflow that calls this connector endpoint — capture it as a skill so the path is applied up front instead of being re-discovered through drift.`
        : group.kind === "rename_param"
          ? `Repairs on the '${interfaceLabel}' interface consistently rename a parameter. This naming convention applies to every workflow on this connector endpoint — capture it as a skill to prevent recurring drift.`
          : group.kind === "add_header"
            ? `Repairs on the '${interfaceLabel}' interface consistently add a header. Every workflow calling this connector endpoint needs it — capture it as a skill.`
            : `Repairs of kind '${group.kind}' recur on the '${interfaceLabel}' interface. This is a standing convention for every workflow on this connector endpoint — capture it as a skill.`;

    signals.push({
      pattern_kind: "repair_pattern",
      scope: "connector",
      connector_id: group.connector_id,
      title: `Recurring ${group.kind} on ${interfaceLabel}`,
      body,
      examples: [
        `Applied ${group.count} times across this interface in the last ${LOOKBACK_DAYS} days`,
      ],
      best_practices: [
        "Document the interface convention so every workflow on this connector applies it without waiting for drift",
      ],
      pitfalls: ["Drift may recur if the upstream API changes this interface again"],
      doc_refs: [],
      fingerprint,
      confidence: computeConfidence(group.count, ratio),
      evidence: group.patch_ids.map((id) => ({
        patch_candidate_id: id,
        evidence_type: "patch_applied" as const,
        summary: `Patch applied: ${group.kind} on ${interfaceLabel}`,
      })),
    });
  }

  logger.debug({
    module: "skill",
    action: "detector.repair.result",
    msg: "repair pattern detector finished",
    tenant_id,
    patches_scanned: rows.length,
    groups_found: signals.length,
    threshold: MIN_PATCH_COUNT,
    skipped_no_proposal,
    skipped_no_endpoint,
  });
  return signals;
}
