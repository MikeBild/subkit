import { z } from "@hono/zod-openapi";
import { proposeLearning } from "../../agent/sessions.ts";
import { LearningKindSchema } from "../../api/agent-sessions.ts";
import { DOMAIN_SLUG_RE } from "../../api/domain-slug.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { toolActor } from "./tool-actor.ts";

const inputSchema = z
  .object({
    kind: LearningKindSchema.default("practice"),
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(4_000),
    domains: z.array(z.string().regex(DOMAIN_SLUG_RE)).max(10).default([]),
    pitfalls: z.array(z.string().min(1).max(500)).max(5).default([]),
  })
  .openapi("SaveLearningToolInput");

export const saveLearningTool: ConversationTool = {
  name: "save_learning",
  description:
    "Save a durable learning from this session — something the user explicitly taught, " +
    "corrected, or confirmed — as a PROPOSAL for human review. It does NOT become live until " +
    "approved. Pick the kind: `practice` for how to work (a rule, convention, gotcha) — it " +
    "becomes a skill; `fact` for what is true in the domain (a name, number, owner, address, " +
    "policy) — it is appended to the domain's knowledge source `learnings-<domain>` and found " +
    "by `search_knowledge`. Pass the domain slug(s) the learning belongs to (e.g. from the " +
    "session briefing). Write title and body in the user's language.",
  inputSchema,
  category: "tenant_write" as const,
  visible_when_readonly: true,
  inert_proposal: true,
  use_case:
    "The user corrects you, states a rule ('never X', 'always Y'), tells you a fact of their domain, or asks to remember something for future sessions.",
  important_notes: [
    "Creates a review-queue proposal only — never live knowledge; no confirmation needed.",
    "Re-saving the same title, kind and domains updates the existing proposal (dedup).",
    "A proposal that was rejected is never proposed again.",
    "Do not save task-specific details or things already covered by loaded skills or knowledge.",
  ],
  example_input: {
    kind: "practice",
    title: "Halbgeviertstrich als Gedankenstrich",
    body: "In deutschen Blog-Artikeln ist der Gedankenstrich immer „ – “ (Halbgeviertstrich mit Leerzeichen), nie „ - “.",
    domains: ["blog-de"],
  },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const result = await proposeLearning({
      tenant_id: ctx.tenant_id,
      title: args.title,
      body: args.body,
      pitfalls: args.pitfalls,
      domains: args.domains,
      kind: args.kind,
      actor: toolActor(ctx),
      confidence: "high",
      evidence_summary: `explicit save_learning (conversation=${ctx.conversation_id})`,
      db: ctx.db,
    });
    if (result.action === "dropped") {
      return {
        ok: false,
        error_code: "sensitive_path",
        message:
          "Not saved: the learning names a key or credential file location. Nothing was queued; restate it without the path.",
        data: { action: result.action, candidate_id: null, kind: args.kind },
      };
    }
    return {
      ok: true,
      data: {
        action: result.action,
        candidate_id: result.candidate_id,
        kind: args.kind,
        note:
          result.action === "skipped"
            ? "An identical learning was already reviewed (approved or rejected) — nothing new was queued."
            : "Queued for human review. Approve it right here (call approve_skill_candidate when the user asks — their client shows the confirmation dialog) or via `sk learnings review`.",
      },
    };
  },
};
