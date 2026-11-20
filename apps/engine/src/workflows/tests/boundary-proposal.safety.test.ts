import { afterAll, beforeAll, expect, test } from "bun:test";
import { tenants, workflows } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { proposeBoundaries } from "../boundary-proposal.ts";
import {
  boundaryProposalFixtures,
  CONNECTOR,
  definition,
  viewer,
} from "./boundary-proposal-fixtures.ts";

let ctx: TestDb;
let tenant_id = "";
let workflow_id = "";

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
  ctx = await createTestDb("boundary_proposal_safety");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "proposal-safety", display_name: "Proposal safety" })
    .returning();
  tenant_id = tenant?.id ?? "";
  const [wf] = await ctx.db
    .insert(workflows)
    .values({ tenant_id, slug: "proposal-safety-wf", name: "Proposal", lifecycle: "active" })
    .returning();
  workflow_id = wf?.id ?? "";
  await fixtures.connect();
});

afterAll(async () => {
  await ctx.cleanup();
});

const propose = (steps: unknown[], as = viewer(tenant_id)) =>
  proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition(steps),
    environment: "prod",
    viewer: as,
  });

const OPAQUE = "Zx81kQpL0vTr7nYw3mBd5cHs9aUe2gFj6iNo4tRy";
const PAT = "glpat-abcdefghij0123456789";

const query = (id: string, key: string) => ({
  id,
  kind: "request",
  connector_id: CONNECTOR,
  method: "GET",
  path: "/v1/export",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  query: { [key]: "${input.credential}" },
});

test("a query key that carries a credential is never proposed, whatever value it took", async () => {
  await fixtures.record([
    { step: "by_token", url: "https://api.example.test/v1/export?token=abc" },
    { step: "by_api_key", url: "https://api.example.test/v1/export?api_key=abc" },
    { step: "by_upper", url: "https://api.example.test/v1/export?Access_Token=abc" },
  ]);
  const derived = await propose([
    query("by_token", "token"),
    query("by_api_key", "api_key"),
    query("by_upper", "Access_Token"),
  ]);
  expect(derived.proposals).toEqual([]);
  expect(derived.unproposable).toEqual([
    { step_id: "by_token", reason: "sensitive_value" },
    { step_id: "by_api_key", reason: "sensitive_value" },
    { step_id: "by_upper", reason: "sensitive_value" },
  ]);
  expect(JSON.stringify(derived)).not.toContain("abc");
});

test("every query key the product treats as a credential is refused the same way", async () => {
  const keys = ["session", "sid", "auth", "code", "key", "signature", "sig", "secret", "password"];
  await fixtures.record(
    keys.map((key) => ({
      step: `by_${key}`,
      url: `https://api.example.test/v1/export?${key}=abc`,
    })),
  );
  const derived = await propose(keys.map((key) => query(`by_${key}`, key)));
  expect(derived.proposals).toEqual([]);
  expect(derived.unproposable).toEqual(
    keys.map((key) => ({ step_id: `by_${key}`, reason: "sensitive_value" })),
  );
  expect(JSON.stringify(derived)).not.toContain("abc");
});

test("a value shaped like a secret is never listed, in a query or in the path", async () => {
  await fixtures.record([
    { step: "by_session", url: `https://api.example.test/v1/export?ref=${PAT}` },
    { step: "by_path", url: `https://api.example.test/v1/files/${OPAQUE}` },
    { step: "by_path", url: "https://api.example.test/v1/files/short" },
  ]);
  const derived = await propose([
    query("by_session", "ref"),
    {
      id: "by_path",
      kind: "request",
      connector_id: CONNECTOR,
      method: "GET",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
      path: "/v1/files/${input.file}",
    },
  ]);
  expect(derived.proposals.map((entry) => [entry.step_id, entry.boundary?.variables])).toEqual([
    ["by_session", { "input.credential": { class: "identifier" } }],
    ["by_path", { "input.file": { class: "identifier" } }],
  ]);
  const wire = JSON.stringify(derived);
  expect(wire).not.toContain(PAT);
  expect(wire).not.toContain(OPAQUE);
  expect(wire).not.toContain("short");
});

test("the sample is the address pattern: no query string, no observed value, no credentials", async () => {
  await fixtures.record([
    {
      step: "read_news",
      url: "https://user:hunter2@api.example.test/v1/news/2026?lang=en&token=abc#frag",
    },
  ]);
  const derived = await propose([
    {
      id: "read_news",
      kind: "request",
      connector_id: CONNECTOR,
      method: "GET",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
      path: "/v1/news/${input.year}",
    },
  ]);
  expect(derived.unproposable).toEqual([]);
  expect(derived.proposals[0]?.evidence).toMatchObject({
    sample: "https://api.example.test/v1/news/{input.year}",
    kind: "sent",
    observations: 1,
  });
  const wire = JSON.stringify(derived);
  for (const leak of ["hunter2", "token", "abc", "lang=en", "?"]) expect(wire).not.toContain(leak);
});

test("runs the viewer may not see are not evidence", async () => {
  await fixtures.clear();
  await fixtures.run(
    [{ step: "read_page", url: "https://api.example.test/v1/pages/private-page" }],
    { caller: { productId: "shop", principalId: "customer-1" } },
  );
  const step = {
    id: "read_page",
    kind: "request",
    connector_id: CONNECTOR,
    method: "GET",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    path: "/v1/pages/${input.slug}",
  };
  const operator = await propose([step]);
  expect(operator).toEqual({
    proposals: [],
    unproposable: [{ step_id: "read_page", reason: "no_history" }],
  });
  const owner = await propose(
    [step],
    viewer(tenant_id, { product_id: "shop", id: "customer-1", kind: "user" }),
  );
  expect(owner.proposals[0]?.boundary?.variables).toEqual({
    "input.slug": { enum: ["private-page"] },
  });
  const stranger = await propose(
    [step],
    viewer(tenant_id, { product_id: "shop", id: "customer-2", kind: "user" }),
  );
  expect(stranger.proposals).toEqual([]);
});
