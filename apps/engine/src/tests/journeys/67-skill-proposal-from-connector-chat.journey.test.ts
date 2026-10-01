// User story: As an operator who opened a chat from a connector's page, I ask
// the assistant to file a skill proposal for that connector — only a proposal,
// not activated — and it files one, instead of telling me no such tool exists
// and sending me to the REST API or an admin.
// Acceptance criteria:
//   - AC1: On the first step of the turn, `create_skill` is in the palette the
//          model is offered. The conversation targets a connector, the same
//          shape as a chat opened with `?connector_id=` from the cockpit.
//   - AC2: When the model calls it, a PROPOSED connector-scoped candidate bound
//          to that connector exists afterwards, and no skill was created —
//          the proposal stays inert until a human approves it.
// Spec refs: docs/concepts/knowledge-and-skills.md, docs/developers/tool-palette.md
//
// The model is the mock provider, used only to issue the call; it records the
// palette each step was offered after every layer between assembly and the
// provider call has had its say, which is what AC1 reads.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createConnector } from "../../connectors/service.ts";
import { skillCandidates, skills } from "../../db/schema/skills.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const TITLE = "Metabase-Datenbanken zuerst auflisten";
const BODY = "Rufe zuerst metabase://databases ab und wähle dann die Datenbank per id.";

let ctx: JourneyCtx;
let connectorId: string;

interface TurnBody {
  events: Array<{ type: string; tool?: string; output?: Record<string, unknown> }>;
}

beforeAll(async () => {
  ctx = await createJourneyCtx("skill-proposal-from-connector-chat");
  const connector = await createConnector(
    {
      tenant_id: ctx.tenantId,
      actor_id: null,
      input: {
        name: "Metabase Reporting",
        slug: "metabase-reporting",
        driver: "http",
        environment: "prod",
        auth_type: "none",
        base_url: "https://metabase.journey.example.com",
      },
    },
    ctx.db,
  );
  connectorId = connector.id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 67: a skill proposal is reachable from a connector-targeted chat", () => {
  test(
    "AC1+AC2: create_skill is offered on step 0 and files an inert connector-scoped proposal",
    async () => {
      const created = await journeyFetch(ctx, "/v1/conversations", {
        method: "POST",
        body: JSON.stringify({ permission_mode: "ask", connector_id: connectorId }),
      });
      expect(created.status).toBe(201);
      const conversation = (
        (await created.json()) as {
          conversation: { id: string; target_connector_id: string | null };
        }
      ).conversation;
      expect(conversation.target_connector_id).toBe(connectorId);

      const mock = getMockProvider();
      const paletteStart = mock.toolPalettes.length;
      mock.setConversePlan(conversation.id, [
        {
          tool: "create_skill",
          args: { scope: "connector", connector_id: connectorId, title: TITLE, body: BODY },
        },
      ]);
      const res = await journeyFetch(ctx, `/v1/conversations/${conversation.id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          message: `Lege für den Konnektor metabase-reporting einen Skill-Vorschlag an (nur Vorschlag, nicht aktivieren), Titel „${TITLE}“, mit genau diesem Inhalt: ${BODY}`,
        }),
      });
      expect([200, 202]).toContain(res.status);
      const turn = (await res.json()) as TurnBody;

      // AC1 — the palette the provider saw on the turn's first step.
      const firstStep = mock.toolPalettes[paletteStart] ?? [];
      expect(firstStep.map((t) => t.name)).toContain("create_skill");

      // AC2 — the call files a proposal, never a skill.
      const result = turn.events.find((e) => e.type === "tool_result" && e.tool === "create_skill");
      expect(result?.output?.action).toBe("proposed");
      const rows = await ctx.db
        .select()
        .from(skillCandidates)
        .where(and(eq(skillCandidates.tenant_id, ctx.tenantId), eq(skillCandidates.title, TITLE)));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("proposed");
      expect(rows[0]?.scope).toBe("connector");
      expect(rows[0]?.connector_id).toBe(connectorId);
      const created_skills = await ctx.db
        .select({ id: skills.id })
        .from(skills)
        .where(and(eq(skills.tenant_id, ctx.tenantId), eq(skills.title, TITLE)));
      expect(created_skills).toHaveLength(0);
    },
    JOURNEY_HOOK_TIMEOUT,
  );
});
