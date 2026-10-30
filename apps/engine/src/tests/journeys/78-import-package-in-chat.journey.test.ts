import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { packageInstalls } from "../../db/schema/index.ts";
import { skills } from "../../db/schema/skills.ts";
import { PACKAGE_CONTENT_TYPE } from "../../identity/portability/format.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { skillPackageArchive } from "../../test-helpers/package-archive.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const SKILLS = ["chat-import-alpha", "chat-import-beta"];

let ctx: JourneyCtx;

interface TurnBody {
  status: string;
  pending_elicitation_id?: string;
}

interface ConversationDetail {
  tool_calls?: Array<{
    tool: string;
    input?: { file_id?: string };
    outcome?: string;
    output?: { plan_digest?: string; summary?: Record<string, number> };
  }>;
  resume_summary?: { pending_approval?: { prompt?: { subjects?: string[] } } | null };
}

async function send(conversationId: string, message: string): Promise<TurnBody> {
  const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
  expect([200, 202]).toContain(res.status);
  return (await res.json()) as TurnBody;
}

async function detail(conversationId: string): Promise<ConversationDetail> {
  const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ConversationDetail;
}

async function importedSkills() {
  return ctx.db
    .select({ slug: skills.slug, lifecycle: skills.lifecycle })
    .from(skills)
    .where(eq(skills.tenant_id, ctx.tenantId));
}

beforeAll(async () => {
  ctx = await createJourneyCtx("import-package-in-chat");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 78: a package attached in the chat is previewed, confirmed and imported", () => {
  test(
    "the model sees the attached package by file id, the card shows the plan, and the import lands once",
    async () => {
      const created = await journeyFetch(ctx, "/v1/conversations", {
        method: "POST",
        body: JSON.stringify({ permission_mode: "ask" }),
      });
      expect(created.status).toBe(201);
      const conversationId = ((await created.json()) as { conversation: { id: string } })
        .conversation.id;

      const mock = getMockProvider();
      mock.setConversePlan(conversationId, [{ text: "Gern, häng das Paket an." }]);
      await send(conversationId, "Ich möchte ein Paket aus einer anderen Instanz einspielen.");

      const uploaded = await journeyFetch(ctx, `/v1/conversations/${conversationId}/attachments`, {
        method: "POST",
        body: JSON.stringify({
          filename: "team.subkit-package.zip",
          content_base64: skillPackageArchive(SKILLS).toString("base64"),
        }),
      });
      expect(uploaded.status).toBe(201);
      const attachment = (await uploaded.json()) as {
        id: string;
        slug: string;
        content_type: string | null;
      };
      expect(attachment.content_type).toBe(PACKAGE_CONTENT_TYPE);

      const callStart = mock.calls.length;
      mock.setConversePlan(conversationId, [
        { tool: "preview_package_import", args: { file_id: `@attachment:${attachment.slug}` } },
      ]);
      await send(conversationId, `Spiel dieses Paket ein @attachment:${attachment.slug}`);
      const seen = mock.calls.slice(callStart).find((call) => call.flow === "converse");
      expect(seen?.last_user).toContain(attachment.id);
      expect(seen?.last_user).not.toContain("Answer briefly.");

      const previewed = (await detail(conversationId)).tool_calls?.find(
        (call) => call.tool === "preview_package_import",
      );
      expect(previewed?.outcome).toBe("ok");
      expect(previewed?.input?.file_id).toBe(attachment.id);
      expect(previewed?.output?.summary).toMatchObject({ create: 2, conflict: 0 });
      const planDigest = previewed?.output?.plan_digest;
      expect(planDigest).toMatch(/^[a-f0-9]{64}$/);

      const paletteStart = mock.toolPalettes.length;
      mock.setConversePlan(conversationId, [
        {
          tool: "apply_package_import",
          args: { file_id: attachment.id, expected_plan_digest: planDigest as string },
        },
      ]);
      const paused = await send(conversationId, "Ja, bitte einspielen.");
      expect((mock.toolPalettes[paletteStart] ?? []).map((t) => t.name)).toContain(
        "apply_package_import",
      );
      expect(paused.status).toBe("awaiting_input");
      expect(paused.pending_elicitation_id).toBeTruthy();
      expect(await importedSkills()).toHaveLength(0);

      const subjects =
        (await detail(conversationId)).resume_summary?.pending_approval?.prompt?.subjects ?? [];
      expect(subjects.join(" ")).toContain("team.subkit-package.zip · 2 create");

      const confirmed = await journeyFetch(
        ctx,
        `/v1/conversations/${conversationId}/elicitations/${paused.pending_elicitation_id}/respond`,
        { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
      );
      expect(confirmed.status).toBe(200);

      const landed = await importedSkills();
      expect(landed.map((row) => row.slug).sort()).toEqual(SKILLS);
      expect(landed.every((row) => row.lifecycle === "draft")).toBe(true);
      const installs = await ctx.db
        .select({ archive_file_id: packageInstalls.archive_file_id })
        .from(packageInstalls)
        .where(and(eq(packageInstalls.tenant_id, ctx.tenantId)));
      expect(installs.map((row) => `fid_${row.archive_file_id}`)).toEqual([attachment.id]);

      const again = await journeyFetch(ctx, "/v1/packages/import/preview", {
        method: "POST",
        body: JSON.stringify({ archive_file_id: attachment.id }),
      });
      expect(again.status).toBe(200);
      const replan = (await again.json()) as { plan: { summary: Record<string, number> } };
      expect(replan.plan.summary).toMatchObject({
        create: 0,
        update: 0,
        conflict: 0,
        unchanged: 2,
      });
    },
    JOURNEY_HOOK_TIMEOUT,
  );
});
