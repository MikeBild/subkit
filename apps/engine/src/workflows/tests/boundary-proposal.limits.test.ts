import { afterAll, beforeAll, expect, test } from "bun:test";
import { tenants, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { proposeBoundaries } from "../boundary-proposal.ts";
import {
  boundaryProposalFixtures,
  CONNECTOR,
  definition,
  QUERY_AUTH,
  STORAGE,
  viewer,
} from "./boundary-proposal-fixtures.ts";

let ctx: TestDb;
let tenant_id = "";
let workflow_id = "";
let reviewed_version = "";
let older_version = "";

const fixtures = boundaryProposalFixtures({
  get ctx() {
    return ctx;
  },
  get workflow_id() {
    return workflow_id;
  },
  get tenant_id() {
    return tenant_id;
  },
});

beforeAll(async () => {
  ctx = await createTestDb("boundary_proposal_limits");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "proposal-limits", display_name: "Proposal limits" })
    .returning();
  tenant_id = tenant?.id ?? "";
  const [wf] = await ctx.db
    .insert(workflows)
    .values({ tenant_id, slug: "proposal-limits-wf", name: "Proposal", lifecycle: "active" })
    .returning();
  workflow_id = wf?.id ?? "";
  const versions = await ctx.db
    .insert(workflowVersions)
    .values(
      [1, 2].map((version) => ({
        tenant_id,
        workflow_id,
        version,
        dag: { name: "Proposal", steps: [] },
      })),
    )
    .returning();
  older_version = versions[0]?.id ?? "";
  reviewed_version = versions[1]?.id ?? "";
  await fixtures.connect();
});

afterAll(async () => {
  await ctx.cleanup();
});

const propose = (steps: unknown[], options: { environment?: "dev" | "prod" } = {}) =>
  proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition(steps),
    version_id: reviewed_version,
    environment: "prod",
    viewer: viewer(tenant_id),
    ...options,
  });

const UUID_A = "8f14e45f-ceea-467a-87f3-b3b6e4d0f8a1";
const UUID_B = "2c1a3b44-5d6e-4f70-8192-a3b4c5d6e7f8";

const localized = {
  id: "read_news",
  kind: "request",
  connector_id: CONNECTOR,
  method: "GET",
  path: "/v1/news",
  query: { lang: "${input.lang}", limit: 10 },
};

test("a placeholder that is a whole query value becomes a query variable with the values it took", async () => {
  await fixtures.record([
    { step: "read_news", url: "https://api.example.test/v1/news?lang=en&limit=10" },
    { step: "read_news", url: "https://api.example.test/v1/news?lang=de&limit=10" },
  ]);
  const { proposals, unproposable } = await propose([localized]);
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.boundary).toEqual({
    variables: { "input.lang": { enum: ["de", "en"] } },
    max_body_bytes: 0,
    max_calls: 4,
  });
  expect(proposals[0]?.request).toEqual({
    method: "GET",
    origin: "https://api.example.test",
    segments: ["", "v1", "news"],
    variables: { "input.lang": { enum: ["de", "en"] } },
    query: { fixed: { limit: "10" }, variable: [{ key: "lang", var: "input.lang" }] },
    max_body_bytes: 0,
    max_calls: 4,
  });
});

test("a vault handle in the query is proposed as a reviewed key, never as a variable", async () => {
  await fixtures.record([
    { step: "read_news", url: "https://api.example.test/v1/news?lang=en&limit=10&account=***" },
    { step: "read_news", url: "https://api.example.test/v1/news?lang=de&limit=10&account=***" },
  ]);
  const { proposals, unproposable } = await propose([
    { ...localized, query: { ...localized.query, account: "${secret.crm-token}" } },
  ]);
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.boundary?.variables).toEqual({ "input.lang": { enum: ["de", "en"] } });
  expect(proposals[0]?.request?.query).toEqual({
    fixed: { limit: "10" },
    variable: [{ key: "lang", var: "input.lang" }],
    vault: ["account"],
  });
});

test("a query value that mixes text with a placeholder is named with the compiler's own reason", async () => {
  await fixtures.record([{ step: "read_news", url: "https://api.example.test/v1/news?lang=en" }]);
  const { proposals, unproposable } = await propose([
    { ...localized, query: { lang: "x-${input.lang}" } },
  ]);
  expect(proposals).toEqual([]);
  expect(unproposable).toEqual([
    { step_id: "read_news", reason: "still_refused", refusal: "query_placeholder_unsupported" },
  ]);
});

const remove = {
  id: "remove_page",
  kind: "request",
  connector_id: CONNECTOR,
  method: "DELETE",
  path: "/v1/pages/${item.id}",
};

test("a removal is proposed as destructive and only over the values it really removed", async () => {
  await fixtures.record([
    { step: "remove_page", url: "https://api.example.test/v1/pages/page-b" },
    { step: "remove_page", url: "https://api.example.test/v1/pages/page-a" },
  ]);
  const { proposals, unproposable } = await propose([remove]);
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.boundary).toEqual({
    variables: { "item.id": { enum: ["page-a", "page-b"] } },
    max_body_bytes: 0,
    max_calls: 4,
    destructive: true,
  });
  expect(proposals[0]?.request?.destructive).toBe(true);
  expect(proposals[0]?.request?.method).toBe("DELETE");
});

test("a removal over ids shaped exactly like a UUID is proposed over those ids", async () => {
  await fixtures.record([
    { step: "remove_page", url: `https://api.example.test/v1/pages/${UUID_B}` },
    { step: "remove_page", url: `https://api.example.test/v1/pages/${UUID_A}` },
  ]);
  const { proposals, unproposable } = await propose([remove]);
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.boundary).toEqual({
    variables: { "item.id": { enum: [UUID_A, UUID_B].sort() } },
    max_body_bytes: 0,
    max_calls: 4,
    destructive: true,
  });
});

test("a removal over any other value too long to read as a list is not proposed", async () => {
  await fixtures.record([
    {
      step: "remove_page",
      url: "https://api.example.test/v1/pages/a-page-name-far-too-long-to-read-in-a-list",
    },
  ]);
  const { proposals, unproposable } = await propose([remove]);
  expect(proposals).toEqual([]);
  expect(unproposable).toEqual([{ step_id: "remove_page", reason: "values_not_describable" }]);
});

test("a removal over more values than a list can carry is not proposed", async () => {
  await fixtures.record(
    Array.from({ length: 13 }, (_, index) => ({
      step: "remove_page",
      url: `https://api.example.test/v1/pages/page-${index}`,
    })),
  );
  const { proposals, unproposable } = await propose([remove]);
  expect(proposals).toEqual([]);
  expect(unproposable).toEqual([{ step_id: "remove_page", reason: "values_not_describable" }]);
});

test("a storage removal gets a ceiling for the objects one run removed", async () => {
  await fixtures.record([
    { step: "expire", key: "v1/cache/a.json" },
    { step: "expire", key: "v1/cache/b.json" },
    { step: "expire", key: "v1/cache/c.json" },
  ]);
  const expire = {
    id: "expire",
    kind: "request",
    protocol: "s3",
    connector_id: STORAGE,
    method: "DELETE",
    s3: { key: "x" },
  };
  const { proposals, unproposable } = await propose([expire]);
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.s3_scope).toEqual({
    key_prefix: "v1/cache/",
    max_bytes: 2048,
    max_deletes: 6,
  });
  expect(proposals[0]?.storage).toEqual({
    operation: "DELETE",
    key_prefix: "v1/cache/",
    max_bytes: 2048,
    max_keys: 1000,
    max_deletes: 6,
  });

  const scoped = await propose([
    { ...expire, s3: { key: "x", scope: { key_prefix: "v1/cache/", max_bytes: 4096 } } },
  ]);
  expect(scoped.proposals[0]?.s3_scope).toEqual({
    key_prefix: "v1/cache/",
    max_bytes: 4096,
    max_deletes: 6,
  });

  const complete = await propose([
    {
      ...expire,
      s3: { key: "x", scope: { key_prefix: "v1/cache/", max_bytes: 4096, max_deletes: 3 } },
    },
  ]);
  expect(complete).toEqual({ proposals: [], unproposable: [] });
});

const store = {
  id: "store_report",
  kind: "request",
  protocol: "s3",
  connector_id: STORAGE,
  method: "PUT",
  s3: { key: "x" },
  body: "x",
};

test("a held storage write is evidence: its key is the held address, its size the held content", async () => {
  await fixtures.record([
    {
      step: "store_report",
      held: { url: "/v1/reports/2026/a.json", method: "PUT", body: "ä".repeat(600) },
    },
  ]);
  const { proposals, unproposable } = await propose([store]);
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.s3_scope).toEqual({ key_prefix: "v1/reports/2026/", max_bytes: 3072 });
  expect(proposals[0]?.evidence.sample).toBe("v1/reports/2026/");
  expect(proposals[0]?.evidence.kind).toBe("trial");
  expect(proposals[0]?.storage?.operation).toBe("PUT");
  expect(JSON.stringify(proposals)).not.toContain("a.json");
});

test("a held request keeps its address on the step and still counts as a trial", async () => {
  const send = {
    id: "send_note",
    kind: "request",
    connector_id: CONNECTOR,
    method: "POST",
    path: "/v1/notes/${input.topic}",
    body: { text: "x" },
  };
  const trial = {
    url: "https://api.example.test/v1/notes/alpha",
    method: "POST",
    body: { text: "x" },
  };
  await fixtures.record([{ step: "send_note", trial }]);
  const held = await propose([send]);
  expect(held.unproposable).toEqual([]);
  expect(held.proposals[0]?.boundary?.variables).toEqual({ "input.topic": { enum: ["alpha"] } });
  expect(held.proposals[0]?.evidence.kind).toBe("trial");

  await fixtures.record([
    { step: "send_note", trial },
    { step: "send_note", url: "https://api.example.test/v1/notes/beta", bytes: 12 },
  ]);
  const sent = await propose([send]);
  expect(sent.proposals[0]?.evidence.kind).toBe("sent");
});

test("the sample of a storage proposal is the proposed folder, never an object that was written", async () => {
  await fixtures.record([
    { step: "store_report", key: "v1/reports/2026/customer-4711.json", bytes: 900 },
    { step: "store_report", key: "v1/reports/2026/customer-4712.json", bytes: 900 },
  ]);
  const { proposals, unproposable } = await propose([store]);
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.evidence.sample).toBe("v1/reports/2026/");
  expect(JSON.stringify(proposals)).not.toContain("customer-47");
});

test("a folder name that looks like a secret or is too long to read makes the step unproposable", async () => {
  const secret = "glpat-abcdefghij0123456789";
  await fixtures.record([
    { step: "store_report", key: `v1/${secret}/a.json`, bytes: 900 },
    { step: "store_report", key: `v1/${secret}/b.json`, bytes: 900 },
  ]);
  const hidden = await propose([store]);
  expect(hidden.proposals).toEqual([]);
  expect(hidden.unproposable).toEqual([{ step_id: "store_report", reason: "sensitive_value" }]);
  expect(JSON.stringify(hidden)).not.toContain(secret);

  const long = "x".repeat(33);
  await fixtures.record([{ step: "store_report", key: `v1/${long}/a.json`, bytes: 900 }]);
  const unreadable = await propose([store]);
  expect(unreadable.proposals).toEqual([]);
  expect(unreadable.unproposable).toEqual([{ step_id: "store_report", reason: "sensitive_value" }]);
  expect(JSON.stringify(unreadable)).not.toContain(long);

  await fixtures.record([{ step: "store_report", key: `v1/${"x".repeat(32)}/a.json`, bytes: 900 }]);
  expect((await propose([store])).unproposable).toEqual([]);
});

test("evidence is read from the reviewed environment only", async () => {
  await fixtures.clear();
  await fixtures.run([{ step: "read_news", url: "https://api.example.test/v1/news?lang=en" }], {
    environment: "prod",
  });
  await fixtures.run([{ step: "read_news", url: "https://api.example.test/v1/news?lang=fr" }], {
    environment: "dev",
  });
  const step = { ...localized, query: { lang: localized.query.lang } };
  const prod = await propose([step], { environment: "prod" });
  expect(prod.proposals[0]?.boundary?.variables).toEqual({ "input.lang": { enum: ["en"] } });
  const dev = await propose([step], { environment: "dev" });
  expect(dev.proposals[0]?.boundary?.variables).toEqual({ "input.lang": { enum: ["fr"] } });
});

test("runs of the reviewed version are preferred, and every version is the fallback", async () => {
  await fixtures.clear();
  await fixtures.run([{ step: "read_news", url: "https://api.example.test/v1/news?lang=en" }], {
    version_id: older_version,
  });
  const step = { ...localized, query: { lang: localized.query.lang } };
  const fallback = await propose([step]);
  expect(fallback.proposals[0]?.boundary?.variables).toEqual({ "input.lang": { enum: ["en"] } });
  await fixtures.run([{ step: "read_news", url: "https://api.example.test/v1/news?lang=de" }], {
    version_id: reviewed_version,
  });
  const preferred = await propose([step]);
  expect(preferred.proposals[0]?.boundary?.variables).toEqual({
    "input.lang": { enum: ["de"] },
  });
});

test("a proposal the real review would still refuse is returned with that refusal instead", async () => {
  await fixtures.record([
    { step: "read_news", url: "https://api.example.test/v1/news?lang=en&limit=10" },
    { step: "orphan", url: "https://api.example.test/v1/pages/alpha" },
    { step: "store_report", key: "v1/reports/a.json", bytes: 900 },
  ]);
  const { proposals, unproposable } = await propose([
    { ...localized, connector_id: QUERY_AUTH },
    {
      id: "orphan",
      kind: "request",
      method: "GET",
      path: "/v1/pages/${input.slug}",
    },
    { ...store, headers: { "x-trace": "1" } },
  ]);
  expect(proposals).toEqual([]);
  expect(unproposable).toEqual([
    { step_id: "read_news", reason: "still_refused", refusal: "connector_query_unresolved" },
    { step_id: "orphan", reason: "still_refused", refusal: "target_unresolved" },
    { step_id: "store_report", reason: "still_refused", refusal: "query_or_headers_present" },
  ]);
});

test("a step that never ran is reported as such even when its address carries a query", async () => {
  await fixtures.clear();
  const { proposals, unproposable } = await propose([
    {
      id: "list",
      kind: "request",
      connector_id: CONNECTOR,
      method: "GET",
      path: "/startups?page=${item.n}&limit=10",
    },
    store,
  ]);
  expect(proposals).toEqual([]);
  expect(unproposable).toEqual([
    { step_id: "list", reason: "no_history" },
    { step_id: "store_report", reason: "no_history" },
  ]);
});
