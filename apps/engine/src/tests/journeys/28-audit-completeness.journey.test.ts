import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { waitFor } from "../../test-helpers/determinism/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const TEST_NOW_MS = getTestNow();

let ctx: JourneyCtx;

let workflowId = "";
let connectorId = "";
let skillActivateId = "";
let skillArchiveId = "";
let skillDeleteId = "";
let apiKeyId = "";
let customRoleId = "";

async function expectAuditRow(action: string, tsFrom: string, extra = ""): Promise<void> {
  await waitFor(
    async () => {
      const res = await journeyFetch(
        ctx,
        `/v1/audit-log?action=${encodeURIComponent(action)}&ts_from=${encodeURIComponent(tsFrom)}&limit=50${extra ? `&${extra}` : ""}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ action: string }> };
      return body.items.some((r) => r.action === action) ? true : undefined;
    },
    { tries: 50, sleepMs: 50, label: `audit row action=${action}` },
  );
}

beforeAll(async () => {
  ctx = await createJourneyCtx("28-audit-completeness");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey: audit completeness over mutation routes", () => {
  test("AC1: POST /v1/workflows → workflow.created", async () => {
    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "ac1-wf",
        slug: "ac1-wf",
        steps: [{ kind: "transform", id: "t1", expression: '"ok"' }],
      }),
    });
    expect(res.status).toBe(201);
    workflowId = ((await res.json()) as { id: string }).id;
    await expectAuditRow("workflow.created", start);
  });

  test("AC2: PUT /v1/workflows/:id → workflow.updated", async () => {
    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, `/v1/workflows/${workflowId}`, {
      method: "PUT",
      body: JSON.stringify({
        name: "ac1-wf",
        slug: "ac1-wf",
        steps: [{ kind: "transform", id: "t1", expression: '"updated"' }],
      }),
    });
    expect(res.status).toBe(200);
    await expectAuditRow("workflow.updated", start);
  });

  test("AC3: DELETE /v1/workflows/:id → workflow.deleted", async () => {
    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, `/v1/workflows/${workflowId}`, {
      method: "DELETE",
    });
    expect([200, 204]).toContain(res.status);
    await expectAuditRow("workflow.deleted", start);
  });

  test("AC4: POST /v1/connectors → connector.created", async () => {
    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, "/v1/connectors", {
      method: "POST",
      body: JSON.stringify({
        name: "Widgets",
        slug: "ac4-widgets",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "http://127.0.0.1:1",
      }),
    });
    expect(res.status).toBe(201);
    connectorId = ((await res.json()) as { id: string }).id;
    await expectAuditRow("connector.created", start);
  });

  test("AC5: PATCH /v1/connectors/:id → connector.updated", async () => {
    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, `/v1/connectors/${connectorId}`, {
      method: "PATCH",
      body: JSON.stringify({ base_url: "http://127.0.0.1:2" }),
    });
    expect(res.status).toBe(200);
    await expectAuditRow("connector.updated", start);
  });

  test("AC7: POST /v1/connectors/:id/credentials → credential.created", async () => {
    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, `/v1/connectors/${connectorId}/credentials`, {
      method: "POST",
      body: JSON.stringify({ mode: "bearer", token: "t-e-s-t" }),
    });
    expect(res.status).toBe(201);
    await expectAuditRow("credential.created", start);
  });

  test("AC8: POST /v1/credentials/:id/rotate → typed rejection for plain credentials", async () => {
    const credRes = await journeyFetch(ctx, `/v1/connectors/${connectorId}`, { method: "GET" });
    let targetConnectorId: string;
    if (credRes.status === 200) {
      targetConnectorId = ((await credRes.json()) as { id: string }).id;
    } else {
      const mk = await journeyFetch(ctx, "/v1/connectors", {
        method: "POST",
        body: JSON.stringify({
          name: "AC8",
          slug: "ac8-widgets",
          driver: "http",
          environment: "dev",
          auth_type: "bearer",
          base_url: "http://127.0.0.1:1",
        }),
      });
      expect(mk.status).toBe(201);
      targetConnectorId = ((await mk.json()) as { id: string }).id;
    }

    const attach = await journeyFetch(ctx, `/v1/connectors/${targetConnectorId}/credentials`, {
      method: "POST",
      body: JSON.stringify({ mode: "bearer", token: "ac8-plain" }),
    });
    expect(attach.status).toBe(201);
    const { id: credentialId } = (await attach.json()) as { id: string };

    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, `/v1/credentials/${credentialId}/rotate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string; code?: string };
    expect(body.message).toBe("cannot_rotate_plain_credential");

    const auditRes = await journeyFetch(
      ctx,
      `/v1/audit-log?action=${encodeURIComponent("credential.rotated")}&ts_from=${encodeURIComponent(start)}&limit=50`,
    );
    expect(auditRes.status).toBe(200);
    const auditBody = (await auditRes.json()) as { items: Array<{ action: string }> };
    expect(auditBody.items.some((r) => r.action === "credential.rotated")).toBe(false);
  });

  test("AC7b: credential.created with mode=aws_sigv4 records a credential digest, never raw keys", async () => {
    const mk = await journeyFetch(ctx, "/v1/connectors", {
      method: "POST",
      body: JSON.stringify({
        name: "AC7b",
        slug: "ac7b-sigv4",
        driver: "http",
        environment: "dev",
        auth_type: "aws_sigv4",
        base_url: "http://127.0.0.1:1",
        config: { aws_region: "us-east-1", aws_service: "execute-api" },
      }),
    });
    expect(mk.status).toBe(201);
    const target = ((await mk.json()) as { id: string }).id;
    const start = new Date(TEST_NOW_MS).toISOString();
    const attach = await journeyFetch(ctx, `/v1/connectors/${target}/credentials`, {
      method: "POST",
      body: JSON.stringify({
        mode: "aws_sigv4",
        access_key_id: "AKIAFAKE0000000FAKE",
        secret_access_key: "secretFAKE/0000000FAKE000000FAKE/000000FAKE",
      }),
    });
    expect(attach.status).toBe(201);
    await expectAuditRow("credential.created", start);
    const auditRes = await journeyFetch(
      ctx,
      `/v1/audit-log?action=${encodeURIComponent("credential.created")}&ts_from=${encodeURIComponent(start)}&limit=10`,
    );
    expect(auditRes.status).toBe(200);
    const auditBody = (await auditRes.json()) as {
      items: Array<{ action: string; metadata: { mode?: string }; details_json?: unknown }>;
    };
    const sigv4Row = auditBody.items.find((r) => r.metadata?.mode === "aws_sigv4");
    expect(sigv4Row).toBeDefined();
    const serialised = JSON.stringify(sigv4Row);
    expect(serialised.includes("secretFAKE/0000000FAKE000000FAKE/000000FAKE")).toBe(false);
  });

  test("AC6: DELETE /v1/connectors/:id → connector.deleted", async () => {
    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, `/v1/connectors/${connectorId}`, {
      method: "DELETE",
    });
    expect([200, 204]).toContain(res.status);
    await expectAuditRow("connector.deleted", start);
  });

  test("AC9: POST /v1/skills → skill.created", async () => {
    const start = new Date(TEST_NOW_MS).toISOString();
    for (const label of ["activate", "archive", "delete"] as const) {
      const res = await journeyFetch(ctx, "/v1/skills", {
        method: "POST",
        body: JSON.stringify({
          scope: "global",
          title: `ac9 skill ${label}`,
          body: `An ac9 skill staged for ${label}.`,
          status: "draft",
        }),
      });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      if (label === "activate") skillActivateId = id;
      if (label === "archive") skillArchiveId = id;
      if (label === "delete") skillDeleteId = id;
    }
    await expectAuditRow("skill.created", start);
  });

  test("AC10: POST /v1/skills/:id/activate → skill.activated", async () => {
    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, `/v1/skills/${skillActivateId}/activate`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    await expectAuditRow("skill.activated", start);
  });

  test("AC11: POST /v1/skills/:id/archive → skill.archived", async () => {
    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, `/v1/skills/${skillArchiveId}/archive`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    await expectAuditRow("skill.archived", start);
  });

  test("AC12: DELETE /v1/skills/:id → skill.deleted", async () => {
    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, `/v1/skills/${skillDeleteId}`, {
      method: "DELETE",
    });
    expect([200, 204]).toContain(res.status);
    await expectAuditRow("skill.deleted", start);
  });

  test("AC13: POST /v1/identity/api-keys → api_key.issued", async () => {
    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, "/v1/identity/api-keys", {
      method: "POST",
      body: JSON.stringify({
        owner_kind: "system_account",
        owner_id: ctx.systemAccountId,
        scopes: ["workflows:read"],
      }),
    });
    expect(res.status).toBe(201);
    apiKeyId = ((await res.json()) as { id: string }).id;
    await expectAuditRow("api_key.issued", start);
  });

  test("AC14: POST /v1/identity/api-keys/:id/rotate → api_key.rotated", async () => {
    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, `/v1/identity/api-keys/${apiKeyId}/rotate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    await expectAuditRow("api_key.rotated", start);
  });

  test("AC15: DELETE /v1/identity/api-keys/:id → api_key.revoked", async () => {
    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, `/v1/identity/api-keys/${apiKeyId}`, {
      method: "DELETE",
    });
    expect([200, 204]).toContain(res.status);
    await expectAuditRow("api_key.revoked", start);
  });

  test("AC16: POST /v1/identity/portal-tokens → portal_token.issued", async () => {
    const wfRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "ac16-wf",
        slug: "ac16-wf",
        steps: [{ kind: "transform", id: "t1", expression: '"portal"' }],
      }),
    });
    const wfId = ((await wfRes.json()) as { id: string }).id;

    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, "/v1/identity/portal-tokens", {
      method: "POST",
      body: JSON.stringify({
        user_id: ctx.userId,
        allowed_workflows: [wfId],
        ttl_minutes: 60,
      }),
    });
    expect(res.status).toBe(201);
    await expectAuditRow("portal_token.issued", start);
  });

  test("AC17: POST /v1/identity/system-accounts → system_account.created", async () => {
    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, "/v1/identity/system-accounts", {
      method: "POST",
      body: JSON.stringify({ name: "ac17-bot", description: "audit completeness bot" }),
    });
    expect(res.status).toBe(201);
    await expectAuditRow("system_account.created", start);
  });

  test("AC18: POST /v1/rbac/roles → rbac.role_created", async () => {
    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, "/v1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "ac18-role", description: "audit completeness role" }),
    });
    expect(res.status).toBe(201);
    customRoleId = ((await res.json()) as { id: string }).id;
    await expectAuditRow("rbac.role_created", start);
  });

  test("AC19: POST /v1/rbac/grants → rbac.grant_created", async () => {
    await journeyFetch(ctx, `/v1/rbac/roles/${customRoleId}/permissions`, {
      method: "POST",
      body: JSON.stringify({ permission: "workflow:read" }),
    });

    const wfRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "ac19-wf",
        slug: "ac19-wf",
        steps: [{ kind: "transform", id: "t1", expression: '"ok"' }],
      }),
    });
    const wfId = ((await wfRes.json()) as { id: string }).id;

    const start = new Date(TEST_NOW_MS).toISOString();
    const res = await journeyFetch(ctx, "/v1/rbac/grants", {
      method: "POST",
      body: JSON.stringify({
        subject_type: "user",
        subject_id: ctx.userId,
        resource_type: "workflow",
        resource_id: wfId,
        permission: "workflow:read",
      }),
    });
    expect(res.status).toBe(201);
    await expectAuditRow("rbac.grant_created", start);
  });
});
