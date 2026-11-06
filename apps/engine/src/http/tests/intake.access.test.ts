import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { generateAccessToken } from "../../auth/oauth/tokens.ts";
import {
  apiKeys,
  knowledgeSources,
  mcpOauthAccessTokens,
  mcpOauthClients,
  skills,
} from "../../db/schema/index.ts";
import { generateKey } from "../../identity/api-key.ts";
import { createSessionIntakeItem } from "../../knowledge/index.ts";
import { createSkill } from "../../skills/service.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import {
  browserPersona,
  browserRequest,
  ctx,
  request,
  setupIntakeHttp,
  testKey,
} from "./intake-fixtures.ts";

setupIntakeHttp();

describe("intake HTTP flow", () => {
  test("rejects confirmation from a system principal and a key without admission rights", async () => {
    const collected = await request("/v1/intake/items", "POST", {
      client_request_id: "10000000-0000-4000-8000-000000000002",
      category: "recording",
      title: "Second recording insight",
      source_url: "https://example.test/second",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "A source clip awaiting review.",
    });
    const item = (await collected.json()) as { id: string };
    const proposed = await request("/v1/intake/proposals", "POST", {
      item_ids: [item.id],
      title: "Second guidance",
      body: "Keep the source clip under review.",
      target: { name: "Second recording knowledge" },
    });
    const proposal = (await proposed.json()) as {
      id: string;
      current_revision: number;
      revision: { digest: string };
    };

    const systemKey = testKey("wf_live_system_confirmation_denied");
    const limitedKey = testKey("wf_live_limited_confirmation_denied");
    await ctx.db.insert(apiKeys).values([
      {
        tenant_id: ctx.tenantId,
        system_account_id: ctx.systemAccountId,
        prefix: systemKey.prefix,
        token_sha256: systemKey.token_sha256,
        scopes: ["*"],
      },
      {
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        prefix: limitedKey.prefix,
        token_sha256: limitedKey.token_sha256,
        scopes: ["intake:confirm"],
      },
    ]);

    const body = { expected_revision: proposal.current_revision, digest: proposal.revision.digest };
    const system = await request(
      `/v1/intake/proposals/${proposal.id}/confirm`,
      "POST",
      body,
      systemKey.plaintext,
    );
    expect(system.status).toBe(403);
    expect((await system.json()) as { code: string }).toMatchObject({
      code: "human_confirmation_required",
    });

    const limited = await request(
      `/v1/intake/proposals/${proposal.id}/confirm`,
      "POST",
      body,
      limitedKey.plaintext,
    );
    expect(limited.status).toBe(403);
  });

  test("rejects confirmation over MCP OAuth and token exchange", async () => {
    const collected = await request("/v1/intake/items", "POST", {
      client_request_id: "10000000-0000-4000-8000-000000000031",
      category: "recording",
      title: "Delegated confirmation clip",
      source_url: "https://example.test/delegated",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "A delegated credential must not admit this.",
    });
    const item = (await collected.json()) as { id: string };
    const proposed = await request("/v1/intake/proposals", "POST", {
      item_ids: [item.id],
      title: "Delegated guidance",
      body: "Only a signed-in person admits this.",
      target: { name: "Delegated recording knowledge" },
    });
    const proposal = (await proposed.json()) as {
      id: string;
      current_revision: number;
      revision: { digest: string };
    };
    const body = { expected_revision: proposal.current_revision, digest: proposal.revision.digest };

    const clientId = "intake-confirm-delegated-client";
    await ctx.db.insert(mcpOauthClients).values({ client_id: clientId, scope: "*" });
    const oauthToken = generateAccessToken();
    await ctx.db.insert(mcpOauthAccessTokens).values({
      tenant_id: ctx.tenantId,
      client_id: clientId,
      user_id: ctx.userId,
      prefix: oauthToken.prefix,
      token_sha256: oauthToken.hash,
      scope: "*",
      resource: `${ctx.baseUrl}/mcp`,
      expires_at: new Date(getTestNow() + 60_000),
    });
    const overMcp = await request(
      `/v1/intake/proposals/${proposal.id}/confirm`,
      "POST",
      body,
      oauthToken.plaintext,
    );
    expect(overMcp.status).toBe(403);

    const exchangeKey = generateKey();
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      prefix: exchangeKey.prefix,
      token_sha256: exchangeKey.hash,
      scopes: ["*"],
    });
    const exchanged = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: exchangeKey.plaintext,
        subject_token_type: "urn:subkit:params:oauth:token-type:api-key",
      }).toString(),
    });
    expect(exchanged.status).toBe(200);
    const { access_token } = (await exchanged.json()) as { access_token: string };
    const overExchange = await request(
      `/v1/intake/proposals/${proposal.id}/confirm`,
      "POST",
      body,
      access_token,
    );
    expect(overExchange.status).toBe(403);
    expect((await overExchange.json()) as { code: string }).toMatchObject({
      code: "human_confirmation_required",
    });

    const stored = await request(`/v1/intake/proposals/${proposal.id}`, "GET");
    expect(((await stored.json()) as { status: string }).status).toBe("draft");
  });

  test("an item read returns its latest session evidence, bounded and newest first", async () => {
    const first = await createSessionIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor: { kind: "user", id: ctx.userId },
        session: {
          agent: "claude-code",
          session_id: "evidence-read-1",
          repo: "example/repo",
          domains: [],
          evidence_excerpt: "user: first mention",
        },
        title: "Evidence read learning",
        body: "Repeated sessions add evidence.",
        captured_at: "2026-10-10T07:00:00.000Z",
      },
      ctx.db,
    );
    await createSessionIntakeItem(
      {
        tenant_id: ctx.tenantId,
        actor: { kind: "user", id: ctx.userId },
        session: {
          agent: "codex",
          session_id: "evidence-read-2",
          repo: null,
          domains: [],
          evidence_excerpt: "user: second mention",
        },
        title: "Evidence read learning",
        body: "Repeated sessions add evidence.",
        captured_at: "2026-10-11T07:00:00.000Z",
      },
      ctx.db,
    );
    const read = await request(`/v1/intake/items/${first.item.id}`, "GET");
    expect(read.status).toBe(200);
    const detail = (await read.json()) as {
      version: number;
      evidence_total: number;
      evidence: Array<{ agent: string; session_id: string; repo: string | null; excerpt: string }>;
    };
    expect(detail.version).toBe(1);
    expect(detail.evidence_total).toBe(2);
    expect(
      detail.evidence.map(({ agent, session_id, repo, excerpt }) => ({
        agent,
        session_id,
        repo,
        excerpt,
      })),
    ).toEqual([
      {
        agent: "codex",
        session_id: "evidence-read-2",
        repo: null,
        excerpt: "user: second mention",
      },
      {
        agent: "claude-code",
        session_id: "evidence-read-1",
        repo: "example/repo",
        excerpt: "user: first mention",
      },
    ]);
  });

  test("keeps existing knowledge routes available", async () => {
    const response = await request("/v1/knowledge-sources", "GET");
    expect(response.status).toBe(200);
  });

  test("uses an actor default shared category and lets the actor replace it", async () => {
    const initial = await request("/v1/intake/default-category", "GET");
    expect(initial.status).toBe(200);
    expect((await initial.json()) as { category: string; can_collect: boolean }).toEqual({
      category: "inbox",
      can_collect: true,
    });

    const updated = await request("/v1/intake/default-category", "PATCH", {
      category: "research",
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()) as { category: string }).toEqual({ category: "research" });

    const collected = await request("/v1/intake/items", "POST", {
      client_request_id: "10000000-0000-4000-8000-000000000004",
      title: "Default category clip",
      source_url: "https://example.test/default-category",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "The server resolves the caller's selected default.",
    });
    expect(collected.status).toBe(201);
    expect((await collected.json()) as { category: string }).toMatchObject({
      category: "research",
    });
  });

  test("requires intake write for a shared category rename only when intake is affected", async () => {
    const limitedKey = testKey("wf_live_category_rename_without_intake_write");
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      prefix: limitedKey.prefix,
      token_sha256: limitedKey.token_sha256,
      scopes: ["workflow:write", "connector:write", "knowledge:write", "skill:write", "file:write"],
    });

    await ctx.db.insert(knowledgeSources).values({
      tenant_id: ctx.tenantId,
      name: "Rename unaffected",
      slug: "rename-unaffected",
      category: "rename-unaffected",
      source_type: "text",
      source_uri: "https://example.test/unaffected",
      version: "initial",
    });
    const unaffected = await request(
      "/v1/categories/rename-unaffected/rename",
      "POST",
      {
        to: "rename-unaffected-next",
        purpose: null,
        aliases: [],
        expected_source_revision: 1,
        expected_target_revision: null,
      },
      limitedKey.plaintext,
    );
    expect(unaffected.status).toBe(200);

    const collected = await request("/v1/intake/items", "POST", {
      client_request_id: "10000000-0000-4000-8000-000000000005",
      category: "rename-restricted",
      title: "Rename protected clip",
      source_url: "https://example.test/rename-restricted",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "A category rename that moves this clip requires intake write.",
    });
    expect(collected.status).toBe(201);

    const affected = await request(
      "/v1/categories/rename-restricted/rename",
      "POST",
      {
        to: "rename-restricted-next",
        purpose: null,
        aliases: [],
        expected_source_revision: 1,
        expected_target_revision: null,
      },
      limitedKey.plaintext,
    );
    expect(affected.status).toBe(403);
  });

  test("requires the target-specific permissions from a browser session for each confirmation", async () => {
    const sessionItem = async (title: string) =>
      (
        await createSessionIntakeItem(
          {
            tenant_id: ctx.tenantId,
            actor: { kind: "user", id: ctx.userId },
            title,
            body: `${title} body`,
            captured_at: "2026-10-10T07:00:00.000Z",
            session: {
              agent: "claude-code",
              session_id: `http-session-${title}`,
              repo: null,
              domains: [],
              evidence_excerpt: `${title} evidence`,
            },
          },
          ctx.db,
        )
      ).item;
    const propose = async (title: string, target: unknown) => {
      const item = await sessionItem(title);
      const response = await request("/v1/intake/proposals", "POST", {
        item_ids: [item.id],
        title,
        body: `${title} proposal body`,
        target,
      });
      expect(response.status).toBe(201);
      const proposal = (await response.json()) as {
        id: string;
        current_revision: number;
        revision: { digest: string };
      };
      return {
        path: `/v1/intake/proposals/${proposal.id}/confirm`,
        body: { expected_revision: proposal.current_revision, digest: proposal.revision.digest },
      };
    };
    const superseded = await createSkill(
      {
        tenant_id: ctx.tenantId,
        input: { scope: "global", title: "Superseded http skill", body: "Old guidance." },
      },
      ctx.db,
    );
    const newSkill = (
      title: string,
      supersedes: { skill_id: string; expected_version: number }[] = [],
    ) => ({
      skill: {
        new: { title, scope: "global", tags: [], category: "jira" },
        supersedes,
      },
    });

    const confirmOnly = await browserPersona(["intake:confirm"]);
    const knowledgeWriter = await browserPersona(["intake:confirm", "knowledge:write"]);
    const skillWriter = await browserPersona(["intake:confirm", "skill:write", "skill:activate"]);
    const skillArchiver = await browserPersona([
      "intake:confirm",
      "skill:write",
      "skill:activate",
      "skill:archive",
    ]);

    const knowledge = await propose("Http knowledge target", { name: "Http knowledge target" });
    for (const persona of [confirmOnly, skillWriter])
      expect((await browserRequest(knowledge.path, knowledge.body, persona)).status).toBe(403);
    expect((await browserRequest(knowledge.path, knowledge.body, knowledgeWriter)).status).toBe(
      200,
    );

    const skill = await propose("Http skill target", newSkill("Http skill target"));
    for (const persona of [confirmOnly, knowledgeWriter])
      expect((await browserRequest(skill.path, skill.body, persona)).status).toBe(403);
    const admitted = await browserRequest(skill.path, skill.body, skillWriter);
    expect(admitted.status).toBe(200);
    const admittedBody = (await admitted.json()) as {
      confirmed_target_kind: string;
      confirmed_target_id: string;
    };
    expect(admittedBody.confirmed_target_kind).toBe("skill");
    const repeated = await browserRequest(skill.path, skill.body, skillWriter);
    expect(repeated.status).toBe(200);
    expect(((await repeated.json()) as { confirmed_target_id: string }).confirmed_target_id).toBe(
      admittedBody.confirmed_target_id,
    );
    expect(
      await ctx.db
        .select({ id: skills.id })
        .from(skills)
        .where(and(eq(skills.tenant_id, ctx.tenantId), eq(skills.title, "Http skill target"))),
    ).toHaveLength(1);

    const replacing = await propose(
      "Http replacing skill",
      newSkill("Http replacing skill", [
        { skill_id: superseded.id, expected_version: superseded.version },
      ]),
    );
    expect((await browserRequest(replacing.path, replacing.body, skillWriter)).status).toBe(403);
    expect((await browserRequest(replacing.path, replacing.body, skillArchiver)).status).toBe(200);

    const stale = await propose("Http stale skill", newSkill("Http stale skill"));
    expect(
      (
        await browserRequest(
          stale.path,
          { ...stale.body, expected_revision: stale.body.expected_revision + 1 },
          skillArchiver,
        )
      ).status,
    ).toBe(409);
  });
});
