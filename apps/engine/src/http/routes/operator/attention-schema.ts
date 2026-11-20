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
        "Stable id: workflow:<id>, conversation:<id>, connector:<id>, connection:<id>, secret-approval:<name>@<version>, skills, budget, freshness:<source>, risk:<kind>, task:<id>.",
      ),
    class: z.enum(["stopped", "failing", "decide"]),
    severity: z.enum(["critical", "urgent", "notice"]),
    kind: z.string(),
    subject: z
      .object({
        kind: z.enum(ATTENTION_SUBJECT_KINDS),
        id: z.string(),
        name: z.string().nullable(),
        environment: z
          .enum(["dev", "prod"])
          .optional()
          .describe(
            "The environment the subject runs in: the one a connector belongs to, and for a workflow, schedule or task the one its automatic starts use. Absent when the subject has none.",
          ),
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
    cause_class: z.enum(PREVIEW_CLASSIFICATIONS).nullable(),
    counts: z.object({
      patches: z.number().int().optional(),
      failures: z.number().int().optional(),
      consecutive_failures: z.number().int().nonnegative().optional().openapi({
        description:
          "Consecutive failed terminal runs, newest completion first. Another terminal status ends the sequence.",
      }),
      skills: z.number().int().optional(),
      intake: z
        .number()
        .int()
        .optional()
        .describe(
          "Collected intake items (clips and session learnings) awaiting review. They are not knowledge or skills until a person confirms a proposal.",
        ),
      intake_by_category: z
        .array(z.object({ category: z.string(), count: z.number().int().positive() }))
        .optional()
        .describe(
          "The intake awaiting review per category, largest first. Counts only, never item contents; the counts sum to intake together with intake_categories_omitted.",
        ),
      intake_categories_omitted: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Items awaiting review in categories beyond those listed in intake_by_category."),
    }),
    since: z.string().nullable(),
    deadline: z.string().nullable(),
    detail: z
      .string()
      .nullable()
      .describe("Residual engine wording, or null. Show it as the engine's wording."),
    waiting_on: z
      .object({ user_id: z.string().uuid(), name: z.string() })
      .optional()
      .describe(
        "Present on an item that needs an approval when the viewer named someone else as their approver: the item waits for that person, who is notified instead of the viewer.",
      ),
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
