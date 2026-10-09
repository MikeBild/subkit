import { afterAll, beforeAll, expect, test } from "bun:test";
import { knowledgeSources, skillCandidates, tenants } from "../../db/schema/index.ts";
import { issueApiKey } from "../../identity/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

let server: HttpTestServer;
let foreignSourceId: string;
const sources = new Map<string, string>();

const examples = [
  { title: "first", tags: ["domain:ops", "domain:other"], target: "learnings-ops" },
  { title: "trimmed", tags: ["domain:ops\u00a0"], target: "learnings-ops" },
  { title: "reversed", tags: ["domain:other", "domain:ops"], target: "learnings-other" },
  { title: "unscoped", tags: [], target: "learnings" },
  { title: "leading", tags: [" domain:ops"], target: "learnings" },
  { title: "empty", tags: ["domain:\u00a0"], target: "learnings" },
  { title: "case", tags: ["Domain:ops"], target: "learnings" },
  { title: "unicode", tags: ["domain:grün"], target: "learnings-grün" },
  { title: "long", tags: [`domain:${"ä".repeat(40)}`], target: `learnings-${"ä".repeat(33)}` },
];

beforeAll(async () => {
  server = await createHttpTestServer("knowledge-proposals");
  for (const slug of new Set(examples.map((example) => example.target))) {
    const [source] = await server.db
      .insert(knowledgeSources)
      .values({
        tenant_id: server.tenantId,
        name: slug,
        slug,
        source_type: "inline",
        source_uri: `${slug}.md`,
        version: "seed",
      })
      .returning();
    if (!source) throw new Error("source seed failed");
    sources.set(slug, source.id);
  }
  await server.db.insert(skillCandidates).values(
    examples.map((example) => ({
      tenant_id: server.tenantId,
      scope: "global" as const,
      pattern_kind: "knowledge_learning" as const,
      title: example.title,
      body: "Proposed fact",
      tags: example.tags,
      evidence: [],
      confidence: "high" as const,
      fingerprint: example.title,
    })),
  );
  await server.db.insert(skillCandidates).values({
    tenant_id: server.tenantId,
    scope: "global",
    pattern_kind: "session_learning",
    title: "not a fact",
    body: "Procedure",
    tags: ["domain:ops"],
    evidence: [],
    confidence: "high",
    fingerprint: "procedure",
  });
  const [foreignTenant] = await server.db
    .insert(tenants)
    .values({ slug: "proposals-foreign", display_name: "Foreign" })
    .returning();
  if (!foreignTenant) throw new Error("foreign tenant seed failed");
  const [foreign] = await server.db
    .insert(knowledgeSources)
    .values({
      tenant_id: foreignTenant.id,
      name: "Foreign",
      slug: "learnings-ops",
      source_type: "inline",
      source_uri: "foreign.md",
      version: "seed",
    })
    .returning();
  if (!foreign) throw new Error("foreign source seed failed");
  foreignSourceId = foreign.id;
  await server.db.insert(skillCandidates).values({
    tenant_id: foreignTenant.id,
    scope: "global",
    pattern_kind: "knowledge_learning",
    title: "foreign fact",
    body: "Foreign fact",
    tags: ["domain:ops"],
    evidence: [],
    confidence: "high",
    fingerprint: "foreign",
  });
});

afterAll(async () => {
  await server.cleanup();
});

async function read(source: string, suffix = "", key = server.apiKey) {
  return fetch(
    `${server.baseUrl}/v1/skill-candidates?knowledge_source_id=${source}&status=proposed${suffix}`,
    { headers: { authorization: `Bearer ${key}` } },
  );
}

test("source filtering matches the exact existing learning target and excludes other tenants and patterns", async () => {
  for (const [slug, id] of sources) {
    const response = await read(id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { title: string }[];
      total: number;
      reviewable_total: number;
    };
    const expected = examples
      .filter((example) => example.target === slug)
      .map((example) => example.title)
      .sort();
    expect(body.items.map((item) => item.title).sort()).toEqual(expected);
    expect(body.total).toBe(expected.length);
    expect(body.reviewable_total).toBe(expected.length);
  }
});

test("source totals are computed before pagination", async () => {
  const id = sources.get("learnings-ops");
  if (!id) throw new Error("source missing");
  const first = await read(id, "&limit=1");
  const second = await read(id, "&limit=1&offset=1");
  const a = (await first.json()) as {
    items: { id: string }[];
    total: number;
    reviewable_total: number;
  };
  const b = (await second.json()) as typeof a;
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(a.total).toBe(2);
  expect(b.total).toBe(2);
  expect(a.reviewable_total).toBe(2);
  expect(a.items).toHaveLength(1);
  expect(b.items).toHaveLength(1);
  expect(a.items[0]?.id).not.toBe(b.items[0]?.id);
});

test("source filters preserve source tenant isolation and require knowledge visibility", async () => {
  expect((await read(foreignSourceId)).status).toBe(404);
  const issued = await issueApiKey(
    {
      tenant_id: server.tenantId,
      owner_kind: "user",
      owner_id: server.userId,
      actor_id: null,
      scopes: ["skill:read"],
    },
    server.db,
  );
  const id = sources.get("learnings-ops");
  if (!id) throw new Error("source missing");
  expect((await read(id, "", issued.plaintext)).status).toBe(403);
  const unfiltered = await fetch(`${server.baseUrl}/v1/skill-candidates`, {
    headers: { authorization: `Bearer ${issued.plaintext}` },
  });
  expect(unfiltered.status).toBe(200);
});
