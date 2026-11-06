import { afterAll, beforeAll } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { apiKeys, connectors, files, users, workflows } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

export let ctx: HttpTestServer;

const PATH = "/v1/agent/briefing";

export async function get(query: string, key?: string): Promise<Response> {
  return fetch(`${ctx.baseUrl}${PATH}?${query}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
}

export async function memberKey(role: string): Promise<string> {
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: `${role}-${randomBytes(8).toString("hex")}@briefing.test`, // allow-random: test identity uniqueness
      role_id: await builtinRoleId(ctx.db, role),
    })
    .returning();
  const key = `wf_live_${randomBytes(24).toString("base64url").slice(0, 32)}`; // allow-random: test only
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: user?.id,
    prefix: key.slice(0, 12),
    token_sha256: createHash("sha256").update(key).digest("hex"),
    scopes: ["*"],
  });
  return key;
}

export async function skillReadOnlyKey(): Promise<string> {
  const key = `wf_live_skill_read_${randomBytes(16).toString("base64url")}`; // allow-random: test only
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    prefix: key.slice(0, 12),
    token_sha256: createHash("sha256").update(key).digest("hex"),
    scopes: ["skill:read"],
  });
  return key;
}

export function postDomains(body: unknown): Promise<Response> {
  return fetch(`${ctx.baseUrl}/v1/agent/domains`, {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function setupAgentBriefing(): void {
  beforeAll(async () => {
    ctx = await createHttpTestServer("agent-briefing");

    const post = (path: string, body: unknown) =>
      fetch(`${ctx.baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ctx.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const skillRes = await post("/v1/skills", {
      scope: "global",
      title: "Hausstil",
      body: "Immer Halbgeviertstrich mit Leerzeichen als Gedankenstrich verwenden.",
      tags: ["domain:blog-de"],
      status: "active",
    });
    if (skillRes.status !== 201 && skillRes.status !== 200) {
      throw new Error(`seed skill failed: ${skillRes.status} ${await skillRes.text()}`);
    }
    await post("/v1/skills", {
      scope: "global",
      title: "Unrelated",
      body: "Belongs to another domain entirely.",
      tags: ["domain:infra"],
      status: "active",
    });
    await post("/v1/skills", {
      scope: "global",
      title: "Skill-only folder",
      body: "A category can establish a folder domain.",
      category: "skill-only",
      status: "active",
    });

    const ksRes = await post("/v1/knowledge-sources/inline", {
      name: "Blog Betrieb",
      slug: "blog-de-betrieb",
      content: "# Betrieb\n\nRelease-Reihenfolge und Gotchas.",
      tags: ["domain:blog-de"],
    });
    if (ksRes.status !== 201) {
      throw new Error(`seed knowledge failed: ${ksRes.status} ${await ksRes.text()}`);
    }
    const knowledgeCategory = await post("/v1/knowledge-sources/inline", {
      name: "Knowledge-only folder",
      slug: "knowledge-only-folder",
      content: "A knowledge category can establish a folder domain.",
      category: "knowledge-only",
    });
    if (knowledgeCategory.status !== 201) {
      throw new Error(`seed categorized knowledge failed: ${knowledgeCategory.status}`);
    }

    await ctx.db.insert(workflows).values([
      {
        tenant_id: ctx.tenantId,
        slug: "blog-de-publish",
        name: "Artikel veröffentlichen",
        description: "Publishes a reviewed article.",
        lifecycle: "active",
      },
      {
        tenant_id: ctx.tenantId,
        slug: "workflow-only-run",
        name: "Workflow-only",
        lifecycle: "active",
        category: "workflow-only",
      },
      { tenant_id: ctx.tenantId, slug: "infra-backup", name: "Backup", lifecycle: "active" },
      { tenant_id: ctx.tenantId, slug: "blog-de-draft", name: "Entwurf", lifecycle: "draft" },
    ]);
    await ctx.db.insert(connectors).values([
      { tenant_id: ctx.tenantId, slug: "blog-de-cms", display_name: "Blog CMS", driver: "http" },
      { tenant_id: ctx.tenantId, slug: "infra-dns", display_name: "DNS", driver: "http" },
      {
        tenant_id: ctx.tenantId,
        slug: "connector-only-api",
        display_name: "Connector-only",
        driver: "http",
        category: "connector-only",
      },
    ]);
    await ctx.db.insert(files).values({
      tenant_id: ctx.tenantId,
      status: "ready",
      filename: "Invoice schema.csv",
      storage_uri: "tenant/test/invoice-schema.csv",
      category: "invoices",
      description: "Current invoice import schema.",
    });
    await ctx.db.insert(files).values([
      {
        tenant_id: ctx.tenantId,
        status: "pending",
        filename: "Unready.csv",
        storage_uri: "tenant/test/unready.csv",
        category: "unready-file",
      },
      {
        tenant_id: ctx.tenantId,
        status: "ready",
        filename: "Deleted.csv",
        storage_uri: "tenant/test/deleted.csv",
        category: "deleted-file",
        deleted_at: new Date(getTestNow()),
      },
    ]);
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
}
