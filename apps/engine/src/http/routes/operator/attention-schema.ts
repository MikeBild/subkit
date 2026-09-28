// attention.v1 — the Zod contract of `buildAttention`, shared by
// `GET /v1/attention` and the digest's `attention` member.

import { z } from "@hono/zod-openapi";
import { PREVIEW_CLASSIFICATIONS } from "../../../execution/index.ts";
import {
  ATTENTION_REASONS,
  ATTENTION_SOURCES,
  ATTENTION_SUBJECT_KINDS,
} from "../../../operator/attention.ts";

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
    severity: z.enum(["critical", "urgent"]),
    kind: z.string(),
    subject: z
      .object({
        kind: z.enum(ATTENTION_SUBJECT_KINDS),
        id: z.string(),
        name: z.string().nullable(),
      })
      .nullable(),
    reason: z.enum(ATTENTION_REASONS),
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
