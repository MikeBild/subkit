// Repair Pattern Detector — identifies recurring field renames / path changes
// from applied patches.
//
// Input: Applied patches for a tenant (last 30 days)
// Grouping key: (workflow_id, patch kind, normalized path)
// Threshold: >= 3 patches in group
// Output: Workflow-scoped PatternSignal (patches are workflow-level; connector
//         context not available on patch_candidates rows)

import { createHash } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { patchCandidates } from "../../db/schema/executions.ts";
import { computeConfidence, type PatternSignal } from "../types.ts";

const MIN_PATCH_COUNT = 3;
const LOOKBACK_DAYS = 30;

interface PatchGroup {
  workflow_id: string;
  kind: string;
  path: string;
  count: number;
  patch_ids: string[];
}

export async function detectRepairPatterns(tenant_id: string, exec: Db): Promise<PatternSignal[]> {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const rows = await exec
    .select()
    .from(patchCandidates)
    .where(
      and(
        eq(patchCandidates.tenant_id, tenant_id),
        eq(patchCandidates.status, "applied"),
        gte(patchCandidates.created_at, cutoff),
      ),
    );

  if (rows.length === 0) return [];

  // The diff JSONB carries: { kind, description, path?, field_path?, ... }
  const groups = new Map<string, PatchGroup>();

  for (const row of rows) {
    const diff = row.diff as Record<string, unknown> | null;
    if (!diff) continue;

    const kind = typeof diff.kind === "string" ? diff.kind : "unknown";
    const path =
      typeof diff.path === "string"
        ? diff.path
        : typeof diff.field_path === "string"
          ? diff.field_path
          : "";

    // Skip patches with no identifiable path — they can't form a pattern
    if (!path) continue;

    const key = `${row.workflow_id}:${kind}:${path}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      existing.patch_ids.push(row.id);
    } else {
      groups.set(key, {
        workflow_id: row.workflow_id,
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

    const totalForWorkflow = rows.filter((r) => r.workflow_id === group.workflow_id).length;
    const ratio = totalForWorkflow > 0 ? group.count / totalForWorkflow : 0;

    const fingerprint = createHash("sha256")
      .update(`repair:${group.workflow_id}:${group.kind}:${group.path}`)
      .digest("hex")
      .slice(0, 32);

    const description =
      group.kind === "update_field_path"
        ? `Field path '${group.path}' is consistently adjusted in responses. Consider adding a skill to document this pattern.`
        : group.kind === "rename_param"
          ? `Parameter '${group.path}' is consistently renamed. Consider adding a skill to document the naming convention.`
          : `Repair pattern '${group.kind}' on path '${group.path}' occurs consistently.`;

    signals.push({
      pattern_kind: "repair_pattern",
      scope: "workflow",
      workflow_id: group.workflow_id,
      title: `Recurring ${group.kind} on ${group.path}`,
      body: description,
      examples: [`Applied ${group.count} times in the last ${LOOKBACK_DAYS} days`],
      best_practices: ["Document the naming convention to prevent future drift"],
      pitfalls: ["Drift may recur if the upstream API changes its naming convention again"],
      doc_refs: [],
      fingerprint,
      confidence: computeConfidence(group.count, ratio),
      evidence: group.patch_ids.map((id) => ({
        patch_candidate_id: id,
        evidence_type: "patch_applied" as const,
        summary: `Patch applied: ${group.kind} on ${group.path}`,
      })),
    });
  }

  return signals;
}
