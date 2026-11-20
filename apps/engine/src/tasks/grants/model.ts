import { z } from "@hono/zod-openapi";
import type { taskGrants } from "../../db/schema/index.ts";
import { TASK_GRANT_AUTHORITY_REVOCATION_REASONS } from "../../workflows/execution-authorities.ts";
import {
  TASK_GRANT_BLOCK_REASONS,
  type TaskGrant,
  TaskGrantInputSchema,
  TaskGrantPreviewSchema,
  TaskGrantSchema,
} from "../types.ts";

const Id = z.string().uuid();
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TASK_AUTHORITY_MAX_RUNS = 10_000;

export const TASK_AUTHORITY_SKIP_REASONS = [
  ...TASK_GRANT_BLOCK_REASONS,
  "workflow_permission_missing",
  "workflow_not_readable",
] as const;

export const TASK_GRANT_REVOCATION_REASONS = [
  "revoked",
  "superseded",
  ...TASK_GRANT_AUTHORITY_REVOCATION_REASONS,
] as const;

export const TaskAuthorityGrantInputSchema = TaskGrantInputSchema.extend({
  max_runs: z.number().int().min(1).max(TASK_AUTHORITY_MAX_RUNS).nullable(),
  expected_workflow_digests: z.record(Id, Digest).default({}),
})
  .strict()
  .openapi("TaskAuthorityGrantInput");

export type TaskAuthorityGrantInput = z.infer<typeof TaskAuthorityGrantInputSchema>;

const { workflows: _blockedOnly, ...previewBase } = TaskGrantPreviewSchema.shape;

export const TaskAuthorityPreviewSchema = z
  .object({
    ...previewBase,
    schedule: z.object({
      schedule_cron: z.string().nullable(),
      schedule_timezone: z.string().nullable(),
      schedule_run_at: z.string().datetime({ offset: true }).nullable(),
    }),
    workflows: z.array(
      TaskGrantPreviewSchema.shape.workflows.element.extend({
        blocked_reason: z.enum(TASK_AUTHORITY_SKIP_REASONS).nullable(),
        covering_authority: z
          .object({
            id: Id,
            valid_until: z.string().datetime({ offset: true }).nullable(),
            remaining_runs: z.number().int().nullable(),
          })
          .nullable(),
        may_grant: z.boolean(),
      }),
    ),
    connectors: z.array(
      z.object({
        connector_id: Id,
        name: z.string().nullable(),
        access: z.enum(["none", "read-only", "read-write"]).nullable(),
      }),
    ),
    web_search: z.boolean(),
    workflow_run_limit_shared_with_other_triggers: z.literal(true),
    live_grant: z.union([TaskGrantSchema, z.null()]),
  })
  .openapi("TaskAuthorityPreview");

export type TaskAuthorityPreview = z.infer<typeof TaskAuthorityPreviewSchema>;

export const TaskAuthorityGrantResultSchema = z
  .object({
    grant: TaskGrantSchema,
    changed: z.boolean(),
    superseded_grant_ids: z.array(Id),
    workflows: z.array(
      z.object({
        workflow_id: Id,
        outcome: z.enum(["granted", "covered", "not_granted"]),
        authority_id: Id.nullable(),
        reason: z.enum(TASK_AUTHORITY_SKIP_REASONS).nullable(),
      }),
    ),
  })
  .openapi("TaskAuthorityGrantResult");

export type TaskAuthorityGrantResult = z.infer<typeof TaskAuthorityGrantResultSchema>;

const AuthorityReleaseShape = {
  revoked_workflow_authority_ids: z.array(Id),
  transferred_workflow_authority_ids: z.array(Id),
  retained_successor_authority_ids: z.array(Id),
};

export const TaskAuthorityRevokeResultSchema = z
  .object({ grant: TaskGrantSchema, changed: z.boolean(), ...AuthorityReleaseShape })
  .openapi("TaskAuthorityRevokeResult");

export type TaskAuthorityRevokeResult = z.infer<typeof TaskAuthorityRevokeResultSchema>;

export type TaskGrantRow = typeof taskGrants.$inferSelect;

export function createdAuthorityIds(row: Pick<TaskGrantRow, "workflow_authority_ids">): string[] {
  const stored: unknown = row.workflow_authority_ids;
  if (!Array.isArray(stored)) return [];
  return stored.filter((id): id is string => typeof id === "string" && UUID.test(id));
}

export function taskGrantView(row: TaskGrantRow): TaskGrant {
  return {
    id: row.id,
    task_id: row.task_id,
    fingerprint: row.fingerprint,
    environment: row.environment,
    valid_from: row.valid_from.toISOString(),
    valid_until: row.valid_until?.toISOString() ?? null,
    max_runs: row.max_runs,
    reserved_runs: row.reserved_runs,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    revoked_at: row.revoked_at?.toISOString() ?? null,
    revoked_by: row.revoked_by,
    workflow_authority_ids: createdAuthorityIds(row),
  };
}

export function taskGrantFailure(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
