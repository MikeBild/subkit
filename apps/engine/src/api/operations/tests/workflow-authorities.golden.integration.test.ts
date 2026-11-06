import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { auditLog, users } from "../../../db/schema/index.ts";
import {
  browserSessionHeaders,
  createHttpTestServer,
  type HttpTestServer,
} from "../../../http/tests/setup.ts";
import { createRole, grantPermissionToRole } from "../../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import {
  seedConnector,
  seedTimestamp,
  seedUuid,
  seedWorkflow,
} from "../../../test-helpers/seed.ts";
import { WorkflowDefSchema } from "../../../workflows/index.ts";

const GOLDEN_PATH = new URL("./fixtures/workflow-authorities.golden.json", import.meta.url)
  .pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};

let ctx: HttpTestServer;
let browser: Record<string, string>;
let noCsrf: Record<string, string>;
let crossSite: Record<string, string>;
const keys: Record<string, string> = {};
let workflowId: string;
let versionId: string;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const STALE = "0".repeat(64);

function normalize(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replaceAll(ctx.userId, "<user>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"trace_id":"[^"]*"/g, '"trace_id":"<trace>"')
    .replace(/"request_id":"[^"]*"/g, '"request_id":"<request>"')
    .replace(/"audit_trace_id":"[^"]*"/g, '"audit_trace_id":"<trace>"')
    .replace(/"prefix":"wf_live_[^"]*"/g, '"prefix":"<key>"')
    .replace(/"(digest|effect_manifest_digest)":"[0-9a-f]{64}"/g, '"$1":"<tenant-digest>"')
    .replace(
      /\b(?!5eed|0f0f0f0f)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
      "<uuid>",
    );
}

function record(name: string, value: unknown): void {
  actual[name] = normalize(value);
  expect(actual[name]).toBe(golden[name] as string);
}

async function http(
  method: string,
  path: string,
  body?: unknown,
  key: string | Record<string, string> = ctx.apiKey,
): Promise<{ status: number; body: unknown }> {
  const headers =
    typeof key === "string"
      ? { authorization: `Bearer ${key}`, "content-type": "application/json" }
      : key;
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function keyWith(name: string, seed: number, permissions: string[]): Promise<string> {
  const role_id = permissions.length
    ? (await createRole(ctx.db, ctx.tenantId, `authority-golden-${name}`)).id
    : await emptyRoleId(ctx.db, ctx.tenantId);
  for (const permission of permissions)
    await grantPermissionToRole(ctx.db, ctx.tenantId, role_id, permission);
  const [user] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email: `authority-golden-${name}@test.local`, role_id })
    .returning();
  if (!user) throw new Error("user insert returned no row");
  const key = `wf_live_${createDeterministicHexFactory(seed)(16)}`;
  await ctx.testDb.pool.query(
    "INSERT INTO subkit.api_keys (tenant_id, user_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [
      ctx.tenantId,
      user.id,
      key.slice(0, 12),
      createHash("sha256").update(key).digest("hex"),
      JSON.stringify(["*"]),
    ],
  );
  return key;
}

async function review(workflow: string, version: string) {
  const preview = await http(
    "GET",
    `/v1/workflows/${workflow}/versions/${version}/authority-preview`,
  );
  return preview.body as {
    digest: string;
    suggested_bounds: { valid_from: string; valid_until: string; max_runs: number };
  };
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_workflow_authorities_golden");
  const connector = await seedConnector(ctx.db, {
    tenant_id: ctx.tenantId,
    id: seedUuid("connector", 1),
    slug: "authority-remote",
    display_name: "Authority remote",
    base_url: "https://example.test/api",
    created_at: seedTimestamp(1),
    updated_at: seedTimestamp(1),
  });
  const authority = await seedWorkflow(ctx.db, {
    tenant_id: ctx.tenantId,
    id: seedUuid("workflow", 1),
    created_at: seedTimestamp(2),
    updated_at: seedTimestamp(2),
    version: { id: seedUuid("workflow_version", 1), created_at: seedTimestamp(2) },
    slug: "authority-target",
    name: "Authority target",
    lifecycle: "draft",
    def: WorkflowDefSchema.parse({
      name: "Authority target",
      slug: "authority-target",
      steps: [
        {
          id: "send",
          kind: "request",
          connector_id: connector.id,
          method: "POST",
          path: "/messages",
          body: { recipient: "reviewed@example.test" },
        },
      ],
    }),
  });
  workflowId = authority.workflow.id;
  versionId = authority.version.id;
  keys.denied = await keyWith("denied", 0x60_31, []);
  keys.read = await keyWith("read", 0x60_32, ["workflow:read"]);
  keys.run = await keyWith("run", 0x60_33, ["workflow:run"]);
  keys.schedule = await keyWith("schedule", 0x60_34, ["schedule:read"]);
  browser = await browserSessionHeaders(ctx, ctx.userId);
  const { "x-subkit-csrf": _csrf, ...withoutCsrf } = browser;
  noCsrf = withoutCsrf;
  crossSite = { ...browser, "sec-fetch-site": "cross-site" };
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("workflow authority routes keep their HTTP responses byte for byte", () => {
  test("automation status", async () => {
    const path = `/v1/workflows/${workflowId}/automation-status`;
    record("http.automation-status", await http("GET", path));
    record("http.automation-status.browser", await http("GET", path, undefined, browser));
    record(
      "http.automation-status.missing",
      await http("GET", `/v1/workflows/${MISSING}/automation-status`),
    );
    record(
      "http.automation-status.bad-id",
      await http("GET", "/v1/workflows/not-a-uuid/automation-status"),
    );
    record("http.automation-status.anonymous", await http("GET", path, undefined, {}));
  });

  test("held report preparation", async () => {
    const path = `/v1/workflows/${workflowId}/versions/${versionId}/prepare-authority`;
    record("http.prepare", await http("POST", path, { environment: "dev" }));
    record("http.prepare.prod", await http("POST", path, { environment: "prod", input: {} }));
    record(
      "http.prepare.missing",
      await http("POST", `/v1/workflows/${workflowId}/versions/${MISSING}/prepare-authority`, {
        environment: "dev",
      }),
    );
    record("http.prepare.invalid", await http("POST", path, { environment: "staging" }));
    record("http.prepare.extra", await http("POST", path, { environment: "dev", other: 1 }));
  });

  test("draft activation", async () => {
    const created = await http("POST", "/v1/workflows/drafts", {
      definition: {
        name: "activate-flow",
        slug: "activate-flow",
        steps: [{ kind: "transform", id: "result", expression: "return 1;" }],
      },
    });
    const draft = created.body as { workflow_id: string; version_id: string };
    const reviewed = await review(draft.workflow_id, draft.version_id);
    const path = `/v1/workflows/${draft.workflow_id}/activate-draft`;
    const body = {
      workflow_version_id: draft.version_id,
      expected_current_version_id: null,
      expected_manifest_digest: reviewed.digest,
      execution_environment: "dev",
    };
    record("http.activate.api-key", await http("POST", path, body));
    record("http.activate.no-csrf", await http("POST", path, body, noCsrf));
    record("http.activate.cross-site", await http("POST", path, body, crossSite));
    record(
      "http.activate.stale",
      await http("POST", path, { ...body, expected_manifest_digest: STALE }, browser),
    );
    record(
      "http.activate.invalid",
      await http("POST", path, { ...body, execution_environment: "staging" }, browser),
    );
    record(
      "http.activate.missing",
      await http("POST", `/v1/workflows/${MISSING}/activate-draft`, body, browser),
    );
    record("http.activate", await http("POST", path, { ...body, start_run: true }, browser));
    record("http.activate.again", await http("POST", path, body, browser));
  });

  test("grant, until revoked and revoke", async () => {
    const base = `/v1/workflows/${workflowId}/execution-authorities`;
    const reviewed = await review(workflowId, versionId);
    const body = {
      workflow_version_id: versionId,
      execution_environment: "dev",
      expected_manifest_digest: reviewed.digest,
      ...reviewed.suggested_bounds,
    };
    record("http.grant.api-key", await http("POST", base, body));
    record("http.grant.no-csrf", await http("POST", base, body, noCsrf));
    record("http.grant.cross-site", await http("POST", base, body, crossSite));
    record(
      "http.grant.stale",
      await http("POST", base, { ...body, expected_manifest_digest: STALE }, browser),
    );
    record("http.grant.invalid", await http("POST", base, { ...body, max_runs: 0 }, browser));
    record(
      "http.grant.missing",
      await http("POST", `/v1/workflows/${MISSING}/execution-authorities`, body, browser),
    );
    const granted = await http("POST", base, body, browser);
    record("http.grant", granted);
    const authorityId = (granted.body as { id: string }).id;
    const until = `${base}/${authorityId}/until-revoked`;
    const digest = { expected_manifest_digest: reviewed.digest };
    record("http.until-revoked.api-key", await http("POST", until, digest));
    record("http.until-revoked.no-csrf", await http("POST", until, digest, noCsrf));
    record(
      "http.until-revoked.stale",
      await http("POST", until, { expected_manifest_digest: STALE }, browser),
    );
    record("http.until-revoked.invalid", await http("POST", until, { other: 1 }, browser));
    record(
      "http.until-revoked.missing",
      await http("POST", `${base}/${MISSING}/until-revoked`, digest, browser),
    );
    const open = await http("POST", until, digest, browser);
    record("http.until-revoked", open);
    const openId = (open.body as { id: string }).id;
    const revoke = `${base}/${openId}/revoke`;
    record("http.revoke.api-key", await http("POST", revoke));
    record("http.revoke.no-csrf", await http("POST", revoke, undefined, noCsrf));
    record("http.revoke.cross-site", await http("POST", revoke, undefined, crossSite));
    record(
      "http.revoke.missing",
      await http("POST", `${base}/${MISSING}/revoke`, undefined, browser),
    );
    record("http.revoke", await http("POST", revoke, undefined, browser));
    record("http.revoke.again", await http("POST", revoke, undefined, browser));
    record(
      "http.until-revoked.revoked",
      await http("POST", `${base}/${openId}/until-revoked`, digest, browser),
    );
  });

  test("each permission is checked before the body is validated", async () => {
    const base = `/v1/workflows/${workflowId}`;
    const routes: [string, string, string, unknown?][] = [
      ["automation-status", "GET", `${base}/automation-status`],
      ["prepare", "POST", `${base}/versions/${versionId}/prepare-authority`, { environment: 1 }],
      ["activate", "POST", `${base}/activate-draft`, { workflow_version_id: 1 }],
      ["grant", "POST", `${base}/execution-authorities`, { workflow_version_id: 1 }],
      ["revoke", "POST", `${base}/execution-authorities/${MISSING}/revoke`],
      [
        "until-revoked",
        "POST",
        `${base}/execution-authorities/${MISSING}/until-revoked`,
        { other: 1 },
      ],
    ];
    for (const holder of ["denied", "read", "run", "schedule"])
      for (const [name, method, path, body] of routes)
        record(
          `http.denied.${holder}.${name}`,
          await http(method, path, body, keys[holder] as string),
        );
  });

  test("audit trail", async () => {
    const rows = await ctx.db
      .select({
        action: auditLog.action,
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
        resource_type: auditLog.resource_type,
        resource_id: auditLog.resource_id,
        result: auditLog.result,
        reason: auditLog.reason,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(eq(auditLog.tenant_id, ctx.tenantId));
    const stable = rows.map(({ metadata, ...row }) => {
      const { runtime: _runtime, ...rest } = (metadata ?? {}) as Record<string, unknown>;
      return normalize({ ...row, metadata: rest });
    });
    record("http.audit", stable.sort());
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
