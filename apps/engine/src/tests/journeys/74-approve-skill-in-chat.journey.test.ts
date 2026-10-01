// User story: As an operator who asked the assistant to propose a skill for a
// connector, I approve that proposal right in the same chat — the assistant
// asks me to confirm, and only my confirmation turns it into a draft skill.
// Nothing becomes active from the chat.
// Acceptance criteria:
//   - AC1: In a connector-targeted web conversation, `create_skill` files a
//          PROPOSED candidate (the precondition journey 67 covers).
//   - AC2: On the first step of the follow-up turn, `approve_skill_candidate`
//          is in the palette the model is offered.
//   - AC3: When the model calls it, the confirm gate pauses the turn with an
//          approval card; until the human answers, no skill exists and the
//          candidate is still proposed.
//   - AC4: After the human confirms, a DRAFT skill exists and the candidate is
//          approved; no active skill was created.
// Spec refs: docs/concepts/knowledge-and-skills.md, docs/developers/tool-palette.md
//
// The model is the mock provider, used only to issue the calls; it records the
// palette each step was offered after every layer between assembly and the
// provider call has had its say, which is what AC2 reads.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createConnector } from "../../connectors/service.ts";
import { skillCandidates, skills } from "../../db/schema/skills.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const TITLE = "Metabase-Karten per id abrufen";
const BODY = "Rufe eine Karte immer über ihre numerische id ab, nie über den Namen.";

let ctx: JourneyCtx;
let connectorId: string;

interface TurnBody {
  status: string;
  pending_elicitation_id?: string;
  events: Array<{ type: string; tool?: string; output?: Record<string, unknown> }>;
}

async function candidateRows() {
  return ctx.db
    .select()
    .from(skillCandidates)
    .where(and(eq(skillCandidates.tenant_id, ctx.tenantId), eq(skillCandidates.title, TITLE)));
}

async function skillRows() {
  return ctx.db
    .select({ id: skills.id, lifecycle: skills.lifecycle })
    .from(skills)
    .where(and(eq(skills.tenant_id, ctx.tenantId), eq(skills.title, TITLE)));
}

beforeAll(async () => {
  ctx = await createJourneyCtx("approve-skill-in-chat");
  const connector = await createConnector(
    {
      tenant_id: ctx.tenantId,
      actor_id: null,
      input: {
        name: "Metabase Cards",
        slug: "metabase-cards",
        driver: "http",
        environment: "prod",
        auth_type: "none",
        base_url: "https://metabase-cards.journey.example.com",
      },
    },
    ctx.db,
  );
  connectorId = connector.id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 74: a skill proposal is approved in the chat behind the confirm gate", () => {
  test(
    "AC1-AC4: approve_skill_candidate is offered, pauses for the human, and yields only a draft",
    async () => {
      const created = await journeyFetch(ctx, "/v1/conversations", {
        method: "POST",
        body: JSON.stringify({ permission_mode: "ask", connector_id: connectorId }),
      });
      expect(created.status).toBe(201);
      const conversationId = ((await created.json()) as { conversation: { id: string } })
        .conversation.id;

      // AC1 — the proposal.
      const mock = getMockProvider();
      mock.setConversePlan(conversationId, [
        {
          tool: "create_skill",
          args: { scope: "connector", connector_id: connectorId, title: TITLE, body: BODY },
        },
      ]);
      const proposeRes = await journeyFetch(ctx, `/v1/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          message: `Schlage für den Konnektor metabase-cards einen Skill „${TITLE}“ vor: ${BODY}`,
        }),
      });
      expect([200, 202]).toContain(proposeRes.status);
      const [candidate] = await candidateRows();
      expect(candidate?.status).toBe("proposed");
      const candidateId = candidate!.id;

      // AC2 — the approve decision is offered on the follow-up turn's first step.
      const paletteStart = mock.toolPalettes.length;
      mock.setConversePlan(conversationId, [
        { tool: "approve_skill_candidate", args: { candidate_id: candidateId } },
      ]);
      const approveRes = await journeyFetch(ctx, `/v1/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ message: "Genehmige den Vorschlag gleich hier." }),
      });
      expect([200, 202]).toContain(approveRes.status);
      const firstStep = mock.toolPalettes[paletteStart] ?? [];
      expect(firstStep.map((t) => t.name)).toContain("approve_skill_candidate");

      // AC3 — the call pauses on the confirm gate; nothing changed yet.
      const paused = (await approveRes.json()) as TurnBody;
      expect(paused.status).toBe("awaiting_input");
      expect(paused.pending_elicitation_id).toBeTruthy();
      expect(await skillRows()).toHaveLength(0);
      expect((await candidateRows())[0]?.status).toBe("proposed");

      // AC4 — the human's confirmation is what creates the skill, as a draft.
      const confirmed = await journeyFetch(
        ctx,
        `/v1/conversations/${conversationId}/elicitations/${paused.pending_elicitation_id}/respond`,
        { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
      );
      expect(confirmed.status).toBe(200);
      const created_skills = await skillRows();
      expect(created_skills).toHaveLength(1);
      expect(created_skills[0]?.lifecycle).toBe("draft");
      expect((await candidateRows())[0]?.status).toBe("approved");
      const active = await ctx.db
        .select({ id: skills.id })
        .from(skills)
        .where(
          and(
            eq(skills.tenant_id, ctx.tenantId),
            eq(skills.title, TITLE),
            eq(skills.lifecycle, "active"),
          ),
        );
      expect(active).toHaveLength(0);
    },
    JOURNEY_HOOK_TIMEOUT,
  );
});
