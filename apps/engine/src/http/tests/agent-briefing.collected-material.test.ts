import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { apiKeys, catalogCategories } from "../../db/schema/index.ts";
import { ctx, get, setupAgentBriefing } from "./agent-briefing-fixtures.ts";
import { browserSessionHeaders } from "./setup.ts";

setupAgentBriefing();

describe("GET /v1/agent/briefing — collected material", () => {
  test("summarizes unconfirmed clips without indexing their body, then discovers confirmed domain knowledge", async () => {
    const clipBody =
      "Intake-only recording phrasing must never be preloaded into an agent briefing.";
    const collected = await fetch(`${ctx.baseUrl}/v1/intake/items`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        client_request_id: "20000000-0000-4000-8000-000000000001",
        category: "briefing-intake",
        title: "Briefing intake recording note",
        source_url: "https://example.test/briefing-intake",
        captured_at: "2026-10-10T07:00:00.000Z",
        body: clipBody,
      }),
    });
    expect(collected.status).toBe(201);
    const item = (await collected.json()) as { id: string };

    const before = await get("domains=briefing-intake", ctx.apiKey);
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as {
      markdown: string;
      intake: { clips: number; sessions: number; proposals: number } | null;
      knowledge_sources: string[];
    };
    expect(beforeBody.intake).toEqual({ clips: 1, sessions: 0, proposals: 0 });
    expect(beforeBody.markdown).toContain("## Collected material");
    expect(beforeBody.markdown).not.toContain(clipBody);
    expect(beforeBody.knowledge_sources).toEqual([]);

    const unconfirmedSearch = await fetch(
      `${ctx.baseUrl}/v1/knowledge-sources/search?q=Intake-only%20recording%20phrasing`,
      { headers: { authorization: `Bearer ${ctx.apiKey}` } },
    );
    expect(unconfirmedSearch.status).toBe(200);
    expect(((await unconfirmedSearch.json()) as { hits: unknown[] }).hits).toHaveLength(0);

    const proposed = await fetch(`${ctx.baseUrl}/v1/intake/proposals`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        item_ids: [item.id],
        title: "Briefing intake guidance",
        body: "Use the reviewed recording guidance in the intended domain.",
        target: {
          name: "Briefing intake knowledge",
          category: "briefing-intake",
          tags: ["domain:briefing-intake"],
        },
      }),
    });
    expect(proposed.status).toBe(201);
    const proposal = (await proposed.json()) as {
      id: string;
      current_revision: number;
      revision: { digest: string };
    };
    const pending = await get("domains=briefing-intake", ctx.apiKey);
    expect(((await pending.json()) as { intake: unknown }).intake).toEqual({
      clips: 1,
      sessions: 0,
      proposals: 1,
    });

    const confirmed = await fetch(`${ctx.baseUrl}/v1/intake/proposals/${proposal.id}/confirm`, {
      method: "POST",
      headers: await browserSessionHeaders(ctx, ctx.userId),
      body: JSON.stringify({
        expected_revision: proposal.current_revision,
        digest: proposal.revision.digest,
      }),
    });
    expect(confirmed.status).toBe(200);

    const after = await get("domains=briefing-intake", ctx.apiKey);
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as {
      markdown: string;
      knowledge_sources: string[];
    };
    expect(afterBody.knowledge_sources).toContain("briefing-intake-knowledge");
    expect(afterBody.markdown).toContain("briefing-intake-knowledge");
    expect(afterBody.markdown).not.toContain(clipBody);

    const confirmedSearch = await fetch(
      `${ctx.baseUrl}/v1/knowledge-sources/search?q=reviewed%20recording%20guidance`,
      { headers: { authorization: `Bearer ${ctx.apiKey}` } },
    );
    expect(confirmedSearch.status).toBe(200);
    expect(((await confirmedSearch.json()) as { hits: unknown[] }).hits).toHaveLength(1);
  });

  test("a confirmed skill target becomes discoverable in its domain briefing without the clip body", async () => {
    const clipBody = "Session-only phrasing about release notes must stay out of briefings.";
    const collected = await fetch(`${ctx.baseUrl}/v1/intake/items`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        client_request_id: "20000000-0000-4000-8000-000000000002",
        category: "briefing-skill",
        title: "Release note convention",
        source_url: "https://example.test/briefing-skill",
        captured_at: "2026-10-10T08:00:00.000Z",
        body: clipBody,
      }),
    });
    expect(collected.status).toBe(201);
    const item = (await collected.json()) as { id: string };

    const before = (await (await get("domains=briefing-skill", ctx.apiKey)).json()) as {
      skills_full: string[];
      skills_title_only: string[];
    };
    expect([...before.skills_full, ...before.skills_title_only]).toEqual([]);

    const proposed = await fetch(`${ctx.baseUrl}/v1/intake/proposals`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        item_ids: [item.id],
        title: "Release note convention",
        body: "Write release notes in the imperative and link the reviewed change.",
        target: {
          skill: {
            new: {
              title: "Release note convention",
              scope: "global",
              tags: ["domain:briefing-skill"],
              category: "briefing-skill",
            },
          },
        },
      }),
    });
    expect(proposed.status).toBe(201);
    const proposal = (await proposed.json()) as {
      id: string;
      current_revision: number;
      revision: { digest: string };
    };
    const confirmed = await fetch(`${ctx.baseUrl}/v1/intake/proposals/${proposal.id}/confirm`, {
      method: "POST",
      headers: await browserSessionHeaders(ctx, ctx.userId),
      body: JSON.stringify({
        expected_revision: proposal.current_revision,
        digest: proposal.revision.digest,
      }),
    });
    expect(confirmed.status).toBe(200);
    const confirmation = (await confirmed.json()) as {
      confirmed_target_kind: string;
      confirmed_target_id: string;
    };
    expect(confirmation.confirmed_target_kind).toBe("skill");
    const skill = (await (
      await fetch(`${ctx.baseUrl}/v1/skills/${confirmation.confirmed_target_id}`, {
        headers: { authorization: `Bearer ${ctx.apiKey}` },
      })
    ).json()) as { slug: string | null; title: string };

    const after = await get("domains=briefing-skill", ctx.apiKey);
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as {
      markdown: string;
      skills_full: string[];
      skills_title_only: string[];
    };
    expect([...afterBody.skills_full, ...afterBody.skills_title_only]).toContain(
      skill.slug ?? skill.title,
    );
    expect(afterBody.markdown).toContain("Release note convention");
    expect(afterBody.markdown).not.toContain(clipBody);
  });

  test("counts collected material of a renamed domain under its former name", async () => {
    const collected = await fetch(`${ctx.baseUrl}/v1/intake/items`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        client_request_id: "20000000-0000-4000-8000-000000000003",
        category: "briefing-renamed",
        title: "Renamed domain note",
        source_url: "https://example.test/briefing-renamed",
        captured_at: "2026-10-10T09:00:00.000Z",
        body: "Collected under the current category name.",
      }),
    });
    expect(collected.status).toBe(201);
    await ctx.db
      .insert(catalogCategories)
      .values({
        tenant_id: ctx.tenantId,
        name: "briefing-before-rename",
        redirect_to: "briefing-renamed",
      })
      .onConflictDoNothing();
    const res = await get("domains=briefing-before-rename", ctx.apiKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { intake: { clips: number; sessions: number } | null };
    expect(body.intake).toMatchObject({ clips: 1, sessions: 0 });
  });

  test("a skill-scoped key without intake access receives no intake summary or reminder", async () => {
    const key = "wf_live_briefing_intake_scoped";
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      prefix: key.slice(0, 12),
      token_sha256: createHash("sha256").update(key).digest("hex"),
      scopes: ["skill:read"],
    });
    const res = await get("domains=briefing-intake", key);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { markdown: string; intake: unknown };
    expect(body.intake).toBeNull();
    expect(body.markdown).not.toContain("## Collected material");
  });
});
