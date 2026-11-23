import { z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { executionSteps, executions, workflowExecutionAuthorities } from "../db/schema/index.ts";
import {
  type ContentPublicationBoundary,
  ContentPublicationBoundarySchema,
  ContentRevisionBoundarySchema,
  type ContentRevisionReceipt,
  ContentRevisionReceiptSchema,
} from "./content-publication-boundary.ts";
import {
  assertHistoryStep,
  assertHistoryVersion,
  historyScopeKey,
  type WorkflowHistoryFacts,
} from "./history-read-facts.ts";

export type ContentPublicationBoundaries = Record<string, ContentPublicationBoundary>;
export function contentPublicationLabels(manifest: unknown, inputs: unknown[]) {
  const allowed = new Set(
    Object.values(contentBoundariesFromManifest(manifest)).flatMap((boundary) =>
      boundary.kind === "content_revision" ? boundary.item_ids : [],
    ),
  );
  const labels = new Map<string, string>();
  const batch = z
    .object({
      config: z
        .array(
          z
            .object({ item_id: z.string().uuid(), repo: z.string().trim().min(1).max(120) })
            .passthrough(),
        )
        .max(100),
    })
    .passthrough();
  for (const input of inputs) {
    const parsed = batch.safeParse(input);
    if (!parsed.success) continue;
    for (const member of parsed.data.config)
      if (allowed.has(member.item_id)) labels.set(member.item_id, member.repo);
  }
  return [...labels].map(([id, label]) => ({ id, label }));
}
export function contentBoundariesFromManifest(manifest: unknown): ContentPublicationBoundaries {
  const parsed = z
    .object({
      effects: z.array(
        z
          .object({
            step_id: z.string(),
            content_publication: z.unknown().optional(),
          })
          .passthrough(),
      ),
    })
    .passthrough()
    .safeParse(manifest);
  const result: ContentPublicationBoundaries = Object.create(null);
  if (!parsed.success) return result;
  for (const effect of parsed.data.effects) {
    const boundary = ContentPublicationBoundarySchema.safeParse(effect.content_publication);
    if (boundary.success) result[effect.step_id] = boundary.data;
  }
  return result;
}

export function revisionStepOwnsRow(stepId: string, key: string): boolean {
  return (
    key === stepId ||
    (key.startsWith(`${stepId}[`) && /^(?:\[\d+\])+$/.test(key.slice(stepId.length)))
  );
}

export async function proposeContentPublicationBoundaries(
  input: {
    tenant_id: string;
    workflow_id: string;
    workflow_version_id: string;
    execution_environment: "dev" | "prod";
  },
  stepIds: string[],
  db: Executor,
  facts?: WorkflowHistoryFacts,
): Promise<ContentPublicationBoundaries> {
  if (facts) {
    assertHistoryVersion(facts, input);
    for (const step_id of stepIds)
      assertHistoryStep(facts, input.tenant_id, input.workflow_id, step_id);
  }
  const authority = facts
    ? facts.authorities.get(historyScopeKey(input))
    : (
        await db
          .select({ manifest: workflowExecutionAuthorities.effect_manifest })
          .from(workflowExecutionAuthorities)
          .where(
            and(
              eq(workflowExecutionAuthorities.tenant_id, input.tenant_id),
              eq(workflowExecutionAuthorities.workflow_id, input.workflow_id),
              eq(workflowExecutionAuthorities.workflow_version_id, input.workflow_version_id),
              eq(workflowExecutionAuthorities.execution_environment, input.execution_environment),
            ),
          )
          .orderBy(
            desc(workflowExecutionAuthorities.created_at),
            desc(workflowExecutionAuthorities.id),
          )
          .limit(1)
      )[0];
  if (authority) return contentBoundariesFromManifest(authority.manifest);
  const run = facts
    ? facts.successful_held.get(historyScopeKey(input))
    : (
        await db
          .select({ id: executions.id })
          .from(executions)
          .where(
            and(
              eq(executions.tenant_id, input.tenant_id),
              eq(executions.workflow_id, input.workflow_id),
              eq(executions.workflow_version_id, input.workflow_version_id),
              eq(executions.execution_mode, input.execution_environment),
              eq(executions.hold_writes, true),
              eq(executions.status, "succeeded"),
            ),
          )
          .orderBy(desc(executions.created_at), desc(executions.id))
          .limit(1)
      )[0];
  if (!run) return {};
  const rows = facts
    ? (facts.steps.get(run.id) ?? []).filter(
        (step) => step.status === "succeeded" && step.kind === "request",
      )
    : await db
        .select({ key: executionSteps.step_key, meta: executionSteps.request_meta })
        .from(executionSteps)
        .where(
          and(
            eq(executionSteps.tenant_id, input.tenant_id),
            eq(executionSteps.execution_id, run.id),
            eq(executionSteps.status, "succeeded"),
            eq(executionSteps.kind, "request"),
          ),
        );
  const observation = z
    .object({
      extras: z
        .object({
          held: z.literal(true),
          content_revision_proposal: z
            .object({
              origin: z.string().url(),
              item_id: z.string().uuid(),
              bytes: z.number().int().positive().max(1_000_000),
            })
            .strict(),
        })
        .passthrough(),
    })
    .passthrough();
  const result: ContentPublicationBoundaries = Object.create(null);
  for (const stepId of stepIds) {
    const owned = rows.filter((row) => revisionStepOwnsRow(stepId, row.key));
    const iterations = owned.filter((row) => row.key !== stepId);
    const ownRows = iterations.length > 0 ? iterations : owned;
    if (!ownRows.length) continue;
    const proposals = ownRows.map((row) => observation.safeParse(row.meta));
    if (proposals.some((proposal) => !proposal.success)) continue;
    const values = proposals.flatMap((proposal) =>
      proposal.success ? [proposal.data.extras.content_revision_proposal] : [],
    );
    if (new Set(values.map((value) => value.origin)).size !== 1) continue;
    const boundary = ContentRevisionBoundarySchema.safeParse({
      kind: "content_revision",
      origin: values[0]!.origin,
      item_ids: [...new Set(values.map((value) => value.item_id))].sort(),
      max_bytes: 1_000_000,
    });
    if (boundary.success) result[stepId] = boundary.data;
  }
  return result;
}

export async function loadContentRevisionReceipts(
  db: Executor,
  tenantId: string,
  executionId: string,
): Promise<ContentRevisionReceipt[]> {
  const rows = await db
    .select({ key: executionSteps.step_key, meta: executionSteps.request_meta })
    .from(executionSteps)
    .innerJoin(
      executions,
      and(
        eq(executions.id, executionSteps.execution_id),
        eq(executions.tenant_id, executionSteps.tenant_id),
      ),
    )
    .where(
      and(
        eq(executionSteps.tenant_id, tenantId),
        eq(executionSteps.execution_id, executionId),
        eq(executionSteps.status, "succeeded"),
        eq(executionSteps.kind, "request"),
        eq(executions.hold_writes, false),
      ),
    );
  return rows.flatMap((row) => {
    const metadata = z
      .object({
        extras: z
          .object({
            held: z.boolean().optional(),
            content_revision_receipt: ContentRevisionReceiptSchema,
          })
          .passthrough(),
      })
      .passthrough()
      .safeParse(row.meta);
    if (!metadata.success || metadata.data.extras.held === true) return [];
    const receipt = metadata.data.extras.content_revision_receipt;
    return revisionStepOwnsRow(receipt.step_id, row.key) ? [receipt] : [];
  });
}
