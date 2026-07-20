// save_learning — explicitly capture a durable learning from the current
// session as a `session_learning` Skill Candidate. The candidate is INERT
// until a human approves it (`sk learnings review` / the approve routes);
// this tool never creates or activates a live skill.

import { z } from "@hono/zod-openapi";
import { DOMAIN_SLUG_RE } from "../../agent/briefing.ts";
import { proposeLearning } from "../../agent/sessions.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(4_000),
    domains: z.array(z.string().regex(DOMAIN_SLUG_RE)).max(10).default([]),
    pitfalls: z.array(z.string().min(1).max(500)).max(5).default([]),
  })
  .openapi("SaveLearningToolInput");

export const saveLearningTool: ConversationTool = {
  name: "save_learning",
  description:
    "Save a durable learning from this session — a rule, convention, gotcha, or fact the " +
    "user explicitly taught, corrected, or confirmed — as a PROPOSED skill candidate for " +
    "human review. It does NOT become live knowledge until approved. Pass the domain " +
    "slug(s) the learning belongs to (e.g. from the session briefing) so the approved " +
    "skill lands in the right domain briefing. Write title and body in the user's language.",
  inputSchema,
  category: "tenant_write" as const,
  // Creates an INERT `proposed` candidate behind the human approve gate —
  // the coding-agent capture loop's explicit channel; authoring principals
  // see no other tenant_write. RBAC `skill:propose` still gates it.
  visible_when_readonly: true,
  use_case:
    "The user corrects you, states a rule ('never X', 'always Y'), or asks to remember something for future sessions.",
  important_notes: [
    "Creates a review-queue proposal only — never live knowledge; no confirmation needed.",
    "Re-saving the same title in the same domains updates the existing proposal (dedup).",
    "Do not save task-specific details or things already covered by loaded skills.",
  ],
  example_input: {
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
      // Human-sanctioned by definition — the model calls this in direct
      // response to an explicit user statement, not from inference.
      confidence: "high",
      evidence_summary: `explicit save_learning (conversation=${ctx.conversation_id})`,
      db: ctx.db,
    });
    return {
      ok: true,
      data: {
        action: result.action,
        candidate_id: result.candidate_id,
        note:
          result.action === "skipped"
            ? "An identical learning was already reviewed (approved or rejected) — nothing new was queued."
            : "Queued for human review. Approve it right here (call approve_skill_candidate when the user asks — their client shows the confirmation dialog) or via `sk learnings review`.",
      },
    };
  },
};
