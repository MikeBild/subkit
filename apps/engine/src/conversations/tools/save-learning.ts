import { z } from "@hono/zod-openapi";
import { collectSessionLearning, learningTargetOf } from "../../agent/sessions.ts";
import { LearningKindSchema } from "../../api/agent-sessions.ts";
import { DOMAIN_SLUG_RE } from "../../api/domain-slug.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";
import { toolActor } from "./tool-actor.ts";

const SAVE_LEARNING_AGENT = "save_learning";

const CLIENT_NAME_MAX = 80;

export function learningClient(
  ctx: Pick<ToolContext, "surface" | "mcp_client_name">,
): string | undefined {
  if (ctx.surface === "mcp") {
    const name = ctx.mcp_client_name?.trim().slice(0, CLIENT_NAME_MAX);
    return name || undefined;
  }
  if (ctx.surface === "sk_headless" || ctx.surface === "sk_interactive") return "sk";
  return "chat";
}

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
    "Collect a durable learning from this session — something the user explicitly taught, " +
    "corrected, or confirmed — into Intake for a person to review. It is NOT knowledge and NOT " +
    "a skill: nothing is used by search, briefings, or authoring until a person reviews it and " +
    "confirms whether it becomes knowledge, a skill, or nothing. Pick the kind as a hint: " +
    "`practice` for how to work (a rule, convention, gotcha), `fact` for what is true in the " +
    "domain (a name, number, owner, address, policy). Pass the domain slug(s) the learning " +
    "belongs to (e.g. from the session briefing); the item lands in the shared category of the " +
    "first domain that exists; in a conversation targeting a connector or workflow the item records " +
    "it as the learning's scope. Do not save events or status updates (a release, a run result) " +
    "or anything that names credentials or where they are stored. Write title and body in the " +
    "user's language.",
  inputSchema,
  category: "tenant_write" as const,
  visible_when_readonly: true,
  inert_proposal: true,
  use_case:
    "The user corrects you, states a rule ('never X', 'always Y'), tells you a fact of their domain, or asks to remember something for future sessions.",
  important_notes: [
    "Collects an intake item only — never live knowledge or an active skill; no confirmation needed.",
    "Saving the same title again in this conversation adds nothing; the same title in the same category adds evidence to the existing item.",
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
    const result = await collectSessionLearning({
      tenant_id: ctx.tenant_id,
      title: args.title,
      body: args.body,
      pitfalls: args.pitfalls,
      kind: args.kind,
      actor: toolActor(ctx),
      session: {
        agent: SAVE_LEARNING_AGENT,
        client: learningClient(ctx),
        session_id: ctx.conversation_id,
        domains: args.domains,
      },
      evidence_excerpt: `explicit save_learning (conversation=${ctx.conversation_id})`,
      target: learningTargetOf(ctx),
      db: ctx.db,
    });
    if (result.outcome === "dropped") {
      return {
        ok: false,
        error_code: "sensitive_path",
        message:
          "Not saved: the learning names a key or credential file location. Nothing was collected; restate it without the path.",
        data: { outcome: result.outcome, intake_item_id: null, kind: args.kind },
      };
    }
    return {
      ok: true,
      data: {
        outcome: result.outcome,
        intake_item_id: result.intake_item_id,
        kind: args.kind,
        note:
          result.outcome === "collected"
            ? "Collected in Intake. A person reviews it there and confirms whether it becomes knowledge or a skill; until then it is not used."
            : "An item with this title was already collected; this session was added to its evidence. It is still awaiting review.",
      },
    };
  },
};
