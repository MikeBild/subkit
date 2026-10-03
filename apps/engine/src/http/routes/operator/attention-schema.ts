// attention.v1 — the Zod contract of `buildAttention`, shared by
// `GET /v1/attention` and the digest's `attention` member.

import { z } from "@hono/zod-openapi";
import { PREVIEW_CLASSIFICATIONS } from "../../../execution/index.ts";
import {
  ATTENTION_REASONS,
  ATTENTION_SOURCES,
  ATTENTION_SUBJECT_KINDS,
} from "../../../operator/attention.ts";
import { BoundaryGrowthSchema } from "../../../workflows/index.ts";

const SourceState = z.enum(["answered", "failed", "not_permitted"]);

const AttentionAction = z
  .object({
    verb: z.enum(["review", "answer", "reauth", "renew", "open_runs", "chat", "open"]),
    href: z.string().describe("Router path under /cockpit where this is acted on."),
    primary: z.boolean(),
    permission: z.string().describe("The permission acting here needs."),
  })
  .openapi("AttentionAction");

const AttentionItem = z
  .object({
    id: z
      .string()
      .describe(
        "Stable id: workflow:<id>, conversation:<id>, connector:<id>, connection:<id>, secret-approval:<name>@<version>, skills, budget, freshness:<source>, risk:<kind>.",
      ),
    class: z.enum(["stopped", "failing", "decide"]),
    severity: z.enum(["critical", "urgent", "notice"]),
    kind: z.string(),
    subject: z
      .object({
        kind: z.enum(ATTENTION_SUBJECT_KINDS),
        id: z.string(),
        name: z.string().nullable(),
      })
      .nullable(),
    reason: z.enum(ATTENTION_REASONS),
    trigger: z
      .object({
        kind: z.enum(["schedule", "inbound_hook"]),
        name: z.string().nullable().describe("The webhook's slug; null for a schedule."),
      })
      .nullable()
      .describe(
        "What starts the workflow. Null unless it is held or the item is about its approval.",
      ),
    approval: z
      .object({
        version: z.number().int(),
        environment: z.enum(["dev", "prod"]),
        growth: z
          .array(BoundaryGrowthSchema)
          .optional()
          .describe(
            "Only on version_awaiting_approval: what this version reaches beyond the approval of the version before it, which is why that approval did not follow.",
          ),
      })
      .optional()
      .describe(
        "The running version an approval item is about and where it runs. Only on version_awaiting_approval, version_needs_repair and approval_expiring.",
      ),
    repair: z
      .object({
        step_id: z.string().nullable(),
        code: z.string().nullable(),
        remedy_kind: z.enum(["patch", "prepare", "declare", "reconnect", "author"]),
        steps: z.number().int(),
        candidate_id: z.string().uuid().nullable(),
        execution_id: z.string().uuid().nullable(),
      })
      .optional()
      .describe(
        "Why no approval may cover that version yet. Only on version_needs_repair: the leading blocked step and its diagnosis code (GET /v1/workflows/{id}/diagnosis), the act that removes it, how many steps are blocked, and the filed repair or the run the diagnosis rests on.",
      ),
    // Inline, not the named `FailureCauseClass`: a nullable $ref is emitted as
    // `allOf` and the generated client loses the null.
    cause_class: z.enum(PREVIEW_CLASSIFICATIONS).nullable(),
    counts: z.object({
      patches: z.number().int().optional(),
      failures: z.number().int().optional(),
      skills: z.number().int().optional(),
    }),
    since: z.string().nullable(),
    deadline: z.string().nullable(),
    detail: z
      .string()
      .nullable()
      .describe("Residual engine wording, or null. Show it as the engine's wording."),
    actions: z.array(AttentionAction),
  })
  .openapi("AttentionItem");

export const AttentionV1Schema = z
  .object({
    schema_version: z.literal("attention.v1"),
    generated_at: z.string(),
    sources: z.object(
      Object.fromEntries(ATTENTION_SOURCES.map((source) => [source, SourceState])) as Record<
        (typeof ATTENTION_SOURCES)[number],
        typeof SourceState
      >,
    ),
    status: z
      .object({
        health_state: z.enum(["healthy", "limited", "critical", "unknown"]),
        next_run_at: z.string().nullable(),
      })
      .nullable(),
    items: z.array(AttentionItem),
  })
  .openapi("AttentionV1");
