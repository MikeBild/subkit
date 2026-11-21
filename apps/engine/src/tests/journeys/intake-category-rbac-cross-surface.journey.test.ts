import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { and, count, eq } from "drizzle-orm";
import { AGENT_FILE_RELPATH, getBriefingHookOutput } from "../../../../sk/src/commands/agent.ts";
import { generateAccessToken } from "../../auth/oauth/tokens.ts";
import {
  intakeItems,
  knowledgeSources,
  mcpOauthAccessTokens,
  mcpOauthClients,
  users,
} from "../../db/schema/index.ts";
import {
  browserSessionHeaders,
  createSecondaryTenant,
  type SecondaryTenant,
} from "../../http/tests/setup.ts";
import { builtinRoleId, createRole, grantPermissionToRole } from "../../rbac/roles.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx } from "./setup.ts";

const CLIP_BODY =
  "Raw field note: the rollback switch sits behind the second release flag on staging.";
const EDITED_BODY = `${CLIP_BODY} Checked again after the edit.`;
const PROPOSAL_BODY =
  "Reviewed release guidance: flip the rollback switch before promoting a staged release.";
const TARGET_NAME = "Release guide knowledge";
const TARGET_SLUG = "release-guide-knowledge";
const DOMAIN = "release-guides";

let ctx: JourneyCtx;
let other: SecondaryTenant;
let collectorKey = "";
let readerKey = "";
let delegatedKey = "";
let mcpOauthToken = "";
let hookRoot = "";
let itemId = "";
let itemVersion = 0;
let staleProposal: Confirmable;
let proposal: Confirmable;
let admittedTargetId = "";
let personaCounter = 0;

interface Confirmable {
  id: string;
  path: string;
  body: { expected_revision: number; digest: string };
}

interface ProposalResponse {
  id: string;
  status: string;
  current_revision: number;
  confirmed_target_id: string | null;
  stale_reason: string | null;
  revision: { digest: string };
}

interface ItemResponse {
  id: string;
  category: string;
  version: number;
  state: string;
  body: string;
  admitted_target_kind: string | null;
  admitted_target_id: string | null;
  original_snapshot: { body: string; source_url?: string; source_author?: string };
}

function api(path: string, method: string, key: string, body?: unknown): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function browserPost(path: string, body: unknown, headers: HeadersInit): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function issueKey(name: string, scopes: string[]): Promise<string> {
  const response = await api("/v1/identity/api-keys", "POST", ctx.apiKey, {
    owner_kind: "user",
    owner_id: ctx.userId,
    name,
    scopes,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { plaintext_key: string }).plaintext_key;
}

async function browserPersona(permissions: string[]): Promise<HeadersInit> {
  personaCounter += 1;
  const role = await createRole(ctx.db, ctx.tenantId, `journey-intake-${personaCounter}`);
  for (const permission of permissions)
    await grantPermissionToRole(ctx.db, ctx.tenantId, role.id, permission);
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: `journey-intake-${personaCounter}@test.local`,
      role_id: await builtinRoleId(ctx.db, "member"),
    })
    .returning();
  if (!user) throw new Error("missing persona user");
  await ctx.db.update(users).set({ role_id: role.id }).where(eq(users.id, user.id));
  return browserSessionHeaders(ctx, user.id);
}

async function connectMcp(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ctx.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "subkit-intake-journey", version: "0.0.0" });
  await client.connect(transport as unknown as Transport);
  return client;
}

async function mcpSearch(token: string, query: string): Promise<string> {
  const client = await connectMcp(token);
  try {
    const result = await client.callTool({ name: "search_knowledge", arguments: { query } });
    expect(result.isError).toBeFalsy();
    return (result.content as Array<{ type: string; text?: string }>)
      .map((part) => part.text ?? "")
      .join("\n");
  } finally {
    await client.close();
  }
}

async function httpHits(key: string, query: string): Promise<Array<{ snippet: string }>> {
  const response = await api(
    `/v1/knowledge-sources/search?q=${encodeURIComponent(query)}`,
    "GET",
    key,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { hits: Array<{ snippet: string }> }).hits;
}

async function briefing(): Promise<{
  markdown: string;
  knowledge_sources: string[];
  intake: { clips: number; sessions: number; proposals: number } | null;
}> {
  const response = await api(`/v1/agent/briefing?domains=${DOMAIN}`, "GET", ctx.apiKey);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    markdown: string;
    knowledge_sources: string[];
    intake: { clips: number; sessions: number; proposals: number } | null;
  };
}

async function hookContext(): Promise<string> {
  const output = await getBriefingHookOutput(
    {
      hook_event_name: "SessionStart",
      cwd: hookRoot,
      session_id: "intake-journey-session",
      transcript_path: null,
      prompt: null,
    },
    {
      profile: {
        name: "journey",
        engine_url: ctx.baseUrl,
        api_key: ctx.apiKey,
        active_tenant_id: null,
      },
      sessionDirectory: join(hookRoot, "sessions"),
    },
  );
  expect(output?.systemMessage).not.toBe("⚠ SubKit");
  return output?.hookSpecificOutput?.additionalContext ?? "";
}

async function knowledgeCount(): Promise<number> {
  const [row] = await ctx.db
    .select({ value: count() })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.tenant_id, ctx.tenantId));
  return row?.value ?? 0;
}

async function readItem(): Promise<ItemResponse> {
  const response = await api(`/v1/intake/items/${itemId}`, "GET", collectorKey);
  expect(response.status).toBe(200);
  return (await response.json()) as ItemResponse;
}

async function readProposal(id: string): Promise<ProposalResponse> {
  const response = await api(`/v1/intake/proposals/${id}`, "GET", collectorKey);
  expect(response.status).toBe(200);
  return (await response.json()) as ProposalResponse;
}

async function propose(title: string): Promise<Confirmable> {
  const response = await api("/v1/intake/proposals", "POST", collectorKey, {
    item_ids: [itemId],
    title,
    body: PROPOSAL_BODY,
    target: { name: TARGET_NAME, category: DOMAIN, tags: [`domain:${DOMAIN}`] },
  });
  expect(response.status).toBe(201);
  const created = (await response.json()) as ProposalResponse;
  return {
    id: created.id,
    path: `/v1/intake/proposals/${created.id}/confirm`,
    body: { expected_revision: created.current_revision, digest: created.revision.digest },
  };
}

beforeAll(async () => {
  ctx = await createJourneyCtx("77-intake-cross-surface");
  other = await createSecondaryTenant(ctx, "intake-journey");
  collectorKey = await issueKey("journey-collector", ["intake:read", "intake:write"]);
  readerKey = await issueKey("journey-reader", ["intake:read"]);
  delegatedKey = await issueKey("journey-admission-key", ["intake:confirm", "knowledge:write"]);

  const clientId = "journey-intake-mcp-client";
  await ctx.db.insert(mcpOauthClients).values({ client_id: clientId, scope: "*" });
  const token = generateAccessToken();
  await ctx.db.insert(mcpOauthAccessTokens).values({
    tenant_id: ctx.tenantId,
    client_id: clientId,
    user_id: ctx.userId,
    prefix: token.prefix,
    token_sha256: token.hash,
    scope: "*",
    resource: ctx.mcpUrl,
    expires_at: new Date(getTestNow() + 3_600_000),
  });
  mcpOauthToken = token.plaintext;

  hookRoot = mkdtempSync(join(tmpdir(), "sk-intake-journey-"));
  mkdirSync(join(hookRoot, ".sk"), { recursive: true });
  writeFileSync(join(hookRoot, AGENT_FILE_RELPATH), JSON.stringify({ domains: [DOMAIN] }));
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (hookRoot) rmSync(hookRoot, { recursive: true, force: true });
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("intake across categories, permissions and surfaces", () => {
  test("AC1: a collector collects into a category; a read-only key cannot collect", async () => {
    const before = await ctx.db
      .select({ value: count() })
      .from(intakeItems)
      .where(eq(intakeItems.tenant_id, ctx.tenantId));
    const denied = await api("/v1/intake/items", "POST", readerKey, {
      client_request_id: "77000000-0000-4000-8000-000000000001",
      category: "field-notes",
      title: "Reader must not collect",
      source_url: "https://example.test/reader",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "This item must not be persisted.",
    });
    expect(denied.status).toBe(403);
    const after = await ctx.db
      .select({ value: count() })
      .from(intakeItems)
      .where(eq(intakeItems.tenant_id, ctx.tenantId));
    expect(after[0]?.value).toBe(before[0]?.value);

    const collected = await api("/v1/intake/items", "POST", collectorKey, {
      client_request_id: "77000000-0000-4000-8000-000000000002",
      category: "field-notes",
      title: "Rollback switch field note",
      source_url: "https://example.test/rollback-switch",
      source_author: "Release engineer",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: CLIP_BODY,
    });
    expect(collected.status).toBe(201);
    const item = (await collected.json()) as ItemResponse;
    itemId = item.id;
    itemVersion = item.version;
    expect(item.category).toBe("field-notes");
    expect(item.admitted_target_id).toBeNull();
  });

  test("AC2: moving the clip and renaming its category never admits it", async () => {
    const moved = await api(`/v1/intake/items/${itemId}`, "PATCH", collectorKey, {
      expected_version: itemVersion,
      category: "release-notes",
    });
    expect(moved.status).toBe(200);
    itemVersion = ((await moved.json()) as ItemResponse).version;

    const renameBody = {
      to: DOMAIN,
      purpose: null,
      aliases: [],
      expected_source_revision: 1,
      expected_target_revision: null,
    };
    const withoutIntakeWrite = await issueKey("journey-rename-without-intake", [
      "workflow:write",
      "connector:write",
      "knowledge:write",
      "skill:write",
      "file:write",
    ]);
    const refused = await api(
      "/v1/categories/release-notes/rename",
      "POST",
      withoutIntakeWrite,
      renameBody,
    );
    expect(refused.status).toBe(403);
    expect((await readItem()).category).toBe("release-notes");

    const renamed = await api(
      "/v1/categories/release-notes/rename",
      "POST",
      ctx.apiKey,
      renameBody,
    );
    expect(renamed.status).toBe(200);
    const item = await readItem();
    itemVersion = item.version;
    expect(item.category).toBe(DOMAIN);
    expect(item.state).not.toBe("admitted");
    expect(item.admitted_target_id).toBeNull();
    expect(await knowledgeCount()).toBe(0);
  });

  test("AC3: before confirmation no surface returns the raw clip", async () => {
    expect(await httpHits(ctx.apiKey, "rollback switch release flag")).toHaveLength(0);
    expect(await mcpSearch(ctx.apiKey, "rollback switch release flag")).not.toMatch(/rollback/i);
    const brief = await briefing();
    expect(brief.intake?.clips).toBe(1);
    expect(brief.knowledge_sources).toEqual([]);
    expect(brief.markdown).not.toContain(CLIP_BODY);
    const hook = await hookContext();
    expect(hook).not.toContain(CLIP_BODY);
    expect(hook).not.toContain(TARGET_SLUG);
  });

  test("AC4: editing the clip after review makes the proposal stale and unconfirmable", async () => {
    staleProposal = await propose("Rollback guidance");
    const edited = await api(`/v1/intake/items/${itemId}`, "PATCH", collectorKey, {
      expected_version: itemVersion,
      body: EDITED_BODY,
    });
    expect(edited.status).toBe(200);
    itemVersion = ((await edited.json()) as ItemResponse).version;
    expect((await readProposal(staleProposal.id)).status).toBe("stale");

    const admitter = await browserPersona(["intake:confirm", "knowledge:write"]);
    const refused = await browserPost(staleProposal.path, staleProposal.body, admitter);
    expect(refused.status).toBe(409);
    expect(await knowledgeCount()).toBe(0);
  });

  test("AC5: keys, MCP, other tenants and under-privileged people cannot confirm", async () => {
    proposal = await propose("Rollback guidance reviewed again");

    for (const key of [collectorKey, delegatedKey, mcpOauthToken]) {
      const denied = await api(proposal.path, "POST", key, proposal.body);
      expect(denied.status).toBe(403);
    }
    const human = await api(proposal.path, "POST", delegatedKey, proposal.body);
    expect((await human.json()) as { code: string }).toMatchObject({
      code: "human_confirmation_required",
    });

    const client = await connectMcp(await issueKey("journey-mcp-admin", ["*", "mcp:admin"]));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("create_intake_proposal");
      expect(names.filter((name) => name.includes("intake") && name.includes("confirm"))).toEqual(
        [],
      );
    } finally {
      await client.close();
    }

    const confirmOnly = await browserPersona(["intake:confirm"]);
    expect((await browserPost(proposal.path, proposal.body, confirmOnly)).status).toBe(403);
    const foreign = await browserPost(
      proposal.path,
      proposal.body,
      await other.admin.sessionHeaders(),
    );
    expect([403, 404]).toContain(foreign.status);

    expect((await readProposal(proposal.id)).status).toBe("draft");
    expect(await knowledgeCount()).toBe(0);
    expect(await httpHits(ctx.apiKey, "flip the rollback switch")).toHaveLength(0);
  });

  test("AC6: a signed-in person with target rights admits exactly once with provenance", async () => {
    const admitter = await browserPersona(["intake:confirm", "knowledge:write"]);
    const confirmed = await browserPost(proposal.path, proposal.body, admitter);
    expect(confirmed.status).toBe(200);
    const body = (await confirmed.json()) as ProposalResponse;
    expect(body.status).toBe("confirmed");
    if (!body.confirmed_target_id) throw new Error("confirmation named no target");
    admittedTargetId = body.confirmed_target_id;

    const repeated = await browserPost(proposal.path, proposal.body, admitter);
    expect(repeated.status).toBe(200);
    expect(((await repeated.json()) as ProposalResponse).confirmed_target_id).toBe(
      admittedTargetId,
    );

    const admitted = await ctx.db
      .select({ id: knowledgeSources.id, slug: knowledgeSources.slug })
      .from(knowledgeSources)
      .where(
        and(eq(knowledgeSources.tenant_id, ctx.tenantId), eq(knowledgeSources.name, TARGET_NAME)),
      );
    expect(admitted).toEqual([{ id: admittedTargetId, slug: TARGET_SLUG }]);
    expect(await knowledgeCount()).toBe(1);

    const item = await readItem();
    expect(item.admitted_target_kind).toBe("knowledge");
    expect(item.admitted_target_id).toBe(admittedTargetId);
    expect(item.body).toBe(EDITED_BODY);
    expect(item.original_snapshot.body).toBe(CLIP_BODY);
    expect(item.original_snapshot.source_url).toBe("https://example.test/rollback-switch");
    expect(item.original_snapshot.source_author).toBe("Release engineer");
    expect((await readProposal(staleProposal.id)).status).toBe("stale");
  });

  test("AC7: HTTP, MCP, the agent briefing and the coding-agent hook find the admitted source", async () => {
    const hits = await httpHits(ctx.apiKey, "flip the rollback switch");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("<b>rollback</b> <b>switch</b>");
    expect(await httpHits(ctx.apiKey, "flag")).toHaveLength(0);

    const viaMcp = await mcpSearch(ctx.apiKey, "flip the rollback switch");
    expect(viaMcp).toContain(TARGET_NAME);
    expect(viaMcp).not.toContain(CLIP_BODY);

    const brief = await briefing();
    expect(brief.knowledge_sources).toContain(TARGET_SLUG);
    expect(brief.markdown).not.toContain(CLIP_BODY);

    const hook = await hookContext();
    expect(hook).toContain(TARGET_SLUG);
    expect(hook).not.toContain(CLIP_BODY);
  });

  test("AC8: the other tenant sees neither the clip nor the admitted knowledge", async () => {
    expect(await httpHits(other.admin.apiKey, "flip the rollback switch")).toHaveLength(0);
    expect((await api(`/v1/intake/items/${itemId}`, "GET", other.admin.apiKey)).status).toBe(404);
    expect(
      (await api(`/v1/knowledge-sources/${admittedTargetId}`, "GET", other.admin.apiKey)).status,
    ).toBe(404);
    expect(await mcpSearch(other.admin.oauthToken, "flip the rollback switch")).not.toMatch(
      /rollback/i,
    );
  });
});
