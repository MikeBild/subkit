import { afterAll, beforeAll, expect, test } from "bun:test";
import { toFileId } from "../../api/files-schemas.ts";
import { connectors, files, knowledgeSources, skills, workflows } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
const paths = new Map<string, string>();
const description = "The description that the person reviewed.";

beforeAll(async () => {
  ctx = await createHttpTestServer("catalog_description_acceptance");
  const metadata = { tenant_id: ctx.tenantId, description, description_source: "llm" };
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({
      ...metadata,
      slug: "description-workflow",
      name: "Description workflow",
      lifecycle: "active",
    })
    .returning();
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      ...metadata,
      slug: "description-connector",
      display_name: "Description connector",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test",
    })
    .returning();
  const [knowledge] = await ctx.db
    .insert(knowledgeSources)
    .values({
      ...metadata,
      slug: "description-knowledge",
      name: "Description knowledge",
      source_type: "inline",
      source_uri: "inline://description",
      version: "fixture",
    })
    .returning();
  const [skill] = await ctx.db
    .insert(skills)
    .values({
      ...metadata,
      title: "Description skill",
      body: "Fixture guidance",
      scope: "global",
      lifecycle: "draft",
    })
    .returning();
  const [file] = await ctx.db
    .insert(files)
    .values({
      ...metadata,
      filename: "description.txt",
      storage_uri: "s3://fixture/description",
      status: "ready",
    })
    .returning();
  if (!workflow || !connector || !knowledge || !skill || !file)
    throw new Error("missing description fixture");
  paths.set("workflow", `/v1/workflows/${workflow.id}/metadata`);
  paths.set("connector", `/v1/connectors/${connector.id}`);
  paths.set("knowledge", `/v1/knowledge-sources/${knowledge.id}`);
  paths.set("skill", `/v1/skills/${skill.id}`);
  paths.set("file", `/v1/files/${toFileId(file.id)}`);
});

afterAll(async () => {
  await ctx.cleanup();
});

for (const kind of ["workflow", "connector", "knowledge", "skill", "file"]) {
  test(`${kind} accepts exactly the reviewed generated description and refuses stale or empty acceptance`, async () => {
    const patch = (body: unknown) =>
      fetch(`${ctx.baseUrl}${paths.get(kind)}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const echo = await patch({ description });
    expect(echo.status).toBe(200);
    expect(await echo.json()).toMatchObject({ description, description_source: "llm" });
    for (const body of [
      { accept_description: true },
      { accept_description: true, description: "" },
      { accept_description: true, description: null },
    ]) {
      const invalid = await patch(body);
      expect(invalid.status).toBe(400);
      await invalid.arrayBuffer();
    }
    const stale = await patch({ accept_description: true, description: "Outdated description" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "description_changed" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const accepted = await patch({ accept_description: true, description });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ description, description_source: "human" });
    }
  });
}
