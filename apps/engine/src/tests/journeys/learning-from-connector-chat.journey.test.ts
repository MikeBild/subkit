import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createConnector } from "../../connectors/service.ts";
import { intakeItems } from "../../db/schema/intake.ts";
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
  ctx = await createJourneyCtx("learning-from-connector-chat");
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

describe("a learning from a connector-targeted chat is collected for review", () => {
  test(
    "AC1+AC2: save_learning is offered on step 0 and collects a connector-scoped intake item",
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
          tool: "save_learning",
          args: { kind: "practice", title: TITLE, body: BODY },
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

      const firstStep = mock.toolPalettes[paletteStart] ?? [];
      const offered = firstStep.map((t) => t.name);
      expect(offered).toContain("save_learning");
      expect(offered).not.toContain("create_skill");

      const result = turn.events.find(
        (e) => e.type === "tool_result" && e.tool === "save_learning",
      );
      expect(result?.output?.outcome).toBe("collected");
      const rows = await ctx.db
        .select()
        .from(intakeItems)
        .where(and(eq(intakeItems.tenant_id, ctx.tenantId), eq(intakeItems.title, TITLE)));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("collected");
      expect(rows[0]?.original_snapshot).toMatchObject({
        origin: "session",
        agent: "save_learning",
        client: "chat",
        session_id: conversation.id,
        scope: "connector",
        connector_id: connectorId,
      });
      const candidates = await ctx.db
        .select({ id: skillCandidates.id })
        .from(skillCandidates)
        .where(and(eq(skillCandidates.tenant_id, ctx.tenantId), eq(skillCandidates.title, TITLE)));
      expect(candidates).toHaveLength(0);
      const created_skills = await ctx.db
        .select({ id: skills.id })
        .from(skills)
        .where(and(eq(skills.tenant_id, ctx.tenantId), eq(skills.title, TITLE)));
      expect(created_skills).toHaveLength(0);
    },
    JOURNEY_HOOK_TIMEOUT,
  );
});
