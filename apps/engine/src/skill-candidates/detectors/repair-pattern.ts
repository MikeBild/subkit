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
// Rows without an execution fixture (null fixture_id) carry no interface
// context and are skipped (counted). Rows whose diff lacks a PatchProposal are
// skipped (counted). The self-healing writer nests the proposal under
// `diff.proposal` (see self-healing/service.ts); `kind` is `proposal.kind` and,
// for `update_field_path`, the field path is `proposal.patch.path`.

import { createHash } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { executionFixtures, patchCandidates } from "../../db/schema/executions.ts";
import { logger } from "../../logging/logger.ts";
import { computeConfidence, type PatternSignal } from "../types.ts";

const MIN_PATCH_COUNT = 3;
const LOOKBACK_DAYS = 30;

interface PatchGroup {
  connector_id: string;
  endpoint_key: string;
  kind: string;
  path: string;
  count: number;
  patch_ids: string[];
}

export async function detectRepairPatterns(tenant_id: string, exec: Db): Promise<PatternSignal[]> {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  // Inner-join to execution_fixtures on BOTH fixture_id and tenant_id: the
  // tenant predicate keeps the read tenant-scoped (no cross-tenant fixture
  // reads), and the inner join naturally drops rows with a null fixture_id.
  const rows = await exec
    .select({
      id: patchCandidates.id,
      diff: patchCandidates.diff,
      connector_id: executionFixtures.connector_id,
      endpoint_key: executionFixtures.endpoint_key,
    })
    .from(patchCandidates)
    .innerJoin(
      executionFixtures,
      and(
        eq(patchCandidates.fixture_id, executionFixtures.id),
        eq(executionFixtures.tenant_id, tenant_id),
      ),
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
    const proposal =
      diff && typeof diff === "object"
        ? (diff.proposal as Record<string, unknown> | undefined)
        : undefined;

    if (!proposal || typeof proposal.kind !== "string") {
      skipped_no_proposal++;
      continue;
    }

    const connector_id = row.connector_id;
    const endpoint_key = row.endpoint_key;
    if (!connector_id || !endpoint_key) {
      skipped_no_endpoint++;
      continue;
    }

    const kind = proposal.kind;
    let path = "";
    if (kind === "update_field_path") {
      const patch = proposal.patch as Record<string, unknown> | undefined;
      if (patch && typeof patch.path === "string") {
        path = patch.path;
      }
    }

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
        endpoint_key,
        kind,
        path,
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

    const pathSuffix = group.path ? ` on path '${group.path}'` : "";
    const body =
      group.kind === "update_field_path"
        ? `Repairs on the '${group.endpoint_key}' interface consistently adjust the field path${pathSuffix}. This is an interface-level convention shared by every workflow that calls this connector endpoint — capture it as a skill so the path is applied up front instead of being re-discovered through drift.`
        : group.kind === "rename_param"
          ? `Repairs on the '${group.endpoint_key}' interface consistently rename a parameter. This naming convention applies to every workflow on this connector endpoint — capture it as a skill to prevent recurring drift.`
          : group.kind === "add_header"
            ? `Repairs on the '${group.endpoint_key}' interface consistently add a header. Every workflow calling this connector endpoint needs it — capture it as a skill.`
            : `Repairs of kind '${group.kind}' recur on the '${group.endpoint_key}' interface${pathSuffix}. This is a standing convention for every workflow on this connector endpoint — capture it as a skill.`;

    signals.push({
      pattern_kind: "repair_pattern",
      scope: "connector",
      connector_id: group.connector_id,
      title: `Recurring ${group.kind} on ${group.endpoint_key}`,
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
        summary: `Patch applied: ${group.kind}${group.path ? ` on ${group.path}` : ""}`,
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
