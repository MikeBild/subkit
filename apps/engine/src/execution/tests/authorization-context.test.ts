import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  apiKeys,
  executions,
  mcpOauthAccessTokens,
  mcpOauthClients,
  sessions,
  users,
} from "../../db/schema/index.ts";
import { sha256Hex } from "../../identity/api-key.ts";
import { can } from "../../rbac/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import {
  authorizationContextFromPrincipal,
  intersectExecutionAllowLists,
  intersectExecutionScopes,
  rehydrateExecutionPrincipal,
} from "../authorization-context.ts";
import { callerFromPrincipal } from "../caller-context.ts";
import { createExecution } from "../state.ts";
import {
  captureWorkflowPermission,
  matchingWorkflowPermission,
  recordStartingWorkflowPermission,
} from "../workflow-permission.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

const nextUuid = createDeterministicUuidFactory(0x4e19);

let ctx: EngineTestCtx;
let userId: string;

beforeAll(async () => {
  ctx = await createEngineCtx("execution-authorization");
  const [user] = await ctx.testDb.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "queued@example.test",
      role_id: await builtinRoleId(ctx.testDb.db, "member"),
    })
    .returning();
  if (!user) throw new Error("user fixture missing");
  userId = user.id;
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

function principal(): ResolvedPrincipal {
  return {
    provider: "api_key",
    tenant_id: ctx.tenantId,
    id: userId,
    kind: "user",
    roles: ["admin"],
  };
}

async function keyPrincipal(label: string) {
  const [key] = await ctx.testDb.db
    .insert(apiKeys)
    .values({
      tenant_id: ctx.tenantId,
      user_id: userId,
      prefix: label,
      token_sha256: sha256Hex(label),
      scopes: ["workflow:run", "connector:read"],
      allowed_workflows: ["original-workflow"],
      allowed_connectors: ["original-connector"],
    })
    .returning();
  if (!key) throw new Error("key fixture missing");
  const owner: ResolvedPrincipal = {
    ...principal(),
    api_key_id: key.id,
    auth_source: {
      kind: "api_key",
      api_key_id: key.id,
      credential_version: sha256Hex(key.token_sha256),
    },
    scopes: key.scopes,
    allowed_workflows: key.allowed_workflows ?? [],
    allowed_connectors: key.allowed_connectors ?? [],
  };
  return { key, owner, captured: authorizationContextFromPrincipal(owner) };
}

test("rehydration keeps admitted credential ceilings while reloading current roles", async () => {
  const { key, owner, captured } = await keyPrincipal("queued-key-ceiling");
  await ctx.testDb.db
    .update(apiKeys)
    .set({ scopes: ["*"], allowed_workflows: ["*"], allowed_connectors: ["*"] })
    .where(and(eq(apiKeys.tenant_id, ctx.tenantId), eq(apiKeys.id, key.id)));
  const hydrated = await rehydrateExecutionPrincipal(
    ctx.testDb.db,
    callerFromPrincipal(owner, ctx.tenantId),
    captured,
  );
  expect(hydrated?.roles).toEqual(["member"]);
  expect(hydrated?.scopes).toEqual(["workflow:run", "connector:read"]);
  expect(hydrated?.allowed_workflows).toEqual(["original-workflow"]);
  expect(hydrated?.allowed_connectors).toEqual(["original-connector"]);
});

test("current connector restrictions narrow the captured allowlist", async () => {
  const { key, owner, captured } = await keyPrincipal("queued-key-narrow");
  await ctx.testDb.db
    .update(apiKeys)
    .set({ allowed_connectors: ["different-connector"] })
    .where(and(eq(apiKeys.tenant_id, ctx.tenantId), eq(apiKeys.id, key.id)));
  const hydrated = await rehydrateExecutionPrincipal(
    ctx.testDb.db,
    callerFromPrincipal(owner, ctx.tenantId),
    captured,
  );
  expect(hydrated?.allowed_connectors).toEqual([]);
});

test("revoking or rotating the original key invalidates queued authentication", async () => {
  const revoked = await keyPrincipal("queued-key-revoked");
  await ctx.testDb.db
    .update(apiKeys)
    .set({ revoked_at: sql`now() - interval '1 second'` })
    .where(and(eq(apiKeys.tenant_id, ctx.tenantId), eq(apiKeys.id, revoked.key.id)));
  await expect(
    rehydrateExecutionPrincipal(
      ctx.testDb.db,
      callerFromPrincipal(revoked.owner, ctx.tenantId),
      revoked.captured,
    ),
  ).rejects.toMatchObject({ code: "execution_authentication_unavailable" });
  const rotated = await keyPrincipal("queued-key-rotated");
  await ctx.testDb.db
    .update(apiKeys)
    .set({ token_sha256: sha256Hex("replacement") })
    .where(and(eq(apiKeys.tenant_id, ctx.tenantId), eq(apiKeys.id, rotated.key.id)));
  await expect(
    rehydrateExecutionPrincipal(
      ctx.testDb.db,
      callerFromPrincipal(rotated.owner, ctx.tenantId),
      rotated.captured,
    ),
  ).rejects.toMatchObject({ code: "execution_authentication_unavailable" });
});

test("browser source requires the original product session and respects revocation", async () => {
  const [session] = await ctx.testDb.db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: userId,
      product_id: "harmoniqs",
      expires_at: new Date(FROZEN_NOW + 60_000),
      absolute_expires_at: new Date(FROZEN_NOW + 60_000),
      last_seen_at: new Date(FROZEN_NOW),
    })
    .returning();
  if (!session) throw new Error("session fixture missing");
  const owner: ResolvedPrincipal = {
    ...principal(),
    provider: "browser_session",
    product_id: "harmoniqs",
    auth_source: { kind: "browser_session", session_id: session.id },
  };
  const caller = callerFromPrincipal(owner, ctx.tenantId, "harmoniqs");
  const authorization = authorizationContextFromPrincipal(owner);
  expect(
    (await rehydrateExecutionPrincipal(ctx.testDb.db, caller, authorization, new Date(FROZEN_NOW)))
      ?.product_id,
  ).toBe("harmoniqs");
  await expect(
    rehydrateExecutionPrincipal(
      ctx.testDb.db,
      { ...caller, productId: "another" },
      authorization,
      new Date(FROZEN_NOW),
    ),
  ).rejects.toMatchObject({ code: "execution_authentication_unavailable" });
  await ctx.testDb.db
    .update(sessions)
    .set({ revoked_at: new Date(FROZEN_NOW) })
    .where(and(eq(sessions.tenant_id, ctx.tenantId), eq(sessions.id, session.id)));
  await expect(
    rehydrateExecutionPrincipal(ctx.testDb.db, caller, authorization, new Date(FROZEN_NOW)),
  ).rejects.toMatchObject({ code: "execution_authentication_unavailable" });
});

test("token exchange expiration survives queue admission", async () => {
  const { key, owner } = await keyPrincipal("queued-key-exchanged");
  owner.auth_source = {
    kind: "token_exchange",
    api_key_id: key.id,
    credential_version: sha256Hex(key.token_sha256),
    expires_at: new Date(FROZEN_NOW + 1_000).toISOString(),
  };
  await expect(
    rehydrateExecutionPrincipal(
      ctx.testDb.db,
      callerFromPrincipal(owner, ctx.tenantId),
      authorizationContextFromPrincipal(owner),
      new Date(FROZEN_NOW + 2_000),
    ),
  ).rejects.toMatchObject({ code: "execution_authentication_unavailable" });
});

test("browser sliding activity keeps a session valid beyond its renewable expiry", async () => {
  const [session] = await ctx.testDb.db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: userId,
      expires_at: new Date(FROZEN_NOW - 1_000),
      absolute_expires_at: new Date(FROZEN_NOW + 60_000),
      last_seen_at: new Date(FROZEN_NOW),
    })
    .returning();
  if (!session) throw new Error("session fixture missing");
  const owner: ResolvedPrincipal = {
    ...principal(),
    auth_source: { kind: "browser_session", session_id: session.id },
  };
  expect(
    await rehydrateExecutionPrincipal(
      ctx.testDb.db,
      callerFromPrincipal(owner, ctx.tenantId),
      authorizationContextFromPrincipal(owner),
      new Date(FROZEN_NOW),
    ),
  ).not.toBeNull();
  await ctx.testDb.db
    .update(sessions)
    .set({ last_seen_at: null })
    .where(and(eq(sessions.tenant_id, ctx.tenantId), eq(sessions.id, session.id)));
  await expect(
    rehydrateExecutionPrincipal(
      ctx.testDb.db,
      callerFromPrincipal(owner, ctx.tenantId),
      authorizationContextFromPrincipal(owner),
      new Date(FROZEN_NOW),
    ),
  ).rejects.toMatchObject({ code: "execution_authentication_unavailable" });
});

test("MCP queue source retains its scope ceiling and refuses disabled clients or revoked tokens", async () => {
  const clientId = "queued-client";
  await ctx.testDb.db.insert(mcpOauthClients).values({ client_id: clientId });
  const [token] = await ctx.testDb.db
    .insert(mcpOauthAccessTokens)
    .values({
      tenant_id: ctx.tenantId,
      user_id: userId,
      client_id: clientId,
      prefix: "queued-mcp",
      token_sha256: sha256Hex("queued-mcp"),
      scope: "workflow:run connector:read",
      expires_at: new Date(FROZEN_NOW + 60_000),
    })
    .returning();
  if (!token) throw new Error("MCP token fixture missing");
  const owner: ResolvedPrincipal = {
    ...principal(),
    scopes: ["workflow:run"],
    auth_source: { kind: "mcp_oauth", access_token_id: token.id, client_id: clientId },
  };
  const caller = callerFromPrincipal(owner, ctx.tenantId);
  const captured = authorizationContextFromPrincipal(owner);
  expect(
    (await rehydrateExecutionPrincipal(ctx.testDb.db, caller, captured, new Date(FROZEN_NOW)))
      ?.scopes,
  ).toEqual(["workflow:run"]);
  await ctx.testDb.db
    .update(mcpOauthClients)
    .set({ disabled_at: new Date(FROZEN_NOW) })
    .where(eq(mcpOauthClients.client_id, clientId));
  await expect(
    rehydrateExecutionPrincipal(ctx.testDb.db, caller, captured, new Date(FROZEN_NOW)),
  ).rejects.toMatchObject({ code: "execution_authentication_unavailable" });
  await ctx.testDb.db
    .update(mcpOauthClients)
    .set({ disabled_at: null })
    .where(eq(mcpOauthClients.client_id, clientId));
  await ctx.testDb.db
    .update(mcpOauthAccessTokens)
    .set({ revoked_at: new Date(FROZEN_NOW) })
    .where(
      and(eq(mcpOauthAccessTokens.tenant_id, ctx.tenantId), eq(mcpOauthAccessTokens.id, token.id)),
    );
  await expect(
    rehydrateExecutionPrincipal(ctx.testDb.db, caller, captured, new Date(FROZEN_NOW)),
  ).rejects.toMatchObject({ code: "execution_authentication_unavailable" });
});

test("missing authentication is refused for callers and allowed only for callerless system jobs", async () => {
  await expect(
    rehydrateExecutionPrincipal(
      ctx.testDb.db,
      callerFromPrincipal(principal(), ctx.tenantId),
      null,
    ),
  ).rejects.toMatchObject({ code: "execution_authentication_unavailable" });
  expect(await rehydrateExecutionPrincipal(ctx.testDb.db, null, null)).toBeNull();
});

test("intersection never promotes disjoint ceilings to unrestricted credentials", () => {
  expect(() => intersectExecutionScopes(["workflow:run"], ["execution:read"])).toThrow(
    "authentication is unavailable",
  );
  expect(intersectExecutionAllowLists([], "all")).toEqual([]);
  expect(intersectExecutionAllowLists("all", ["only"])).toEqual(["only"]);
});

test("permission evidence is bound to the real caller and workflow and cannot replace authentication", async () => {
  const { owner, key } = await keyPrincipal("permission-proof");
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "Permission proof",
    steps: [{ id: "result", kind: "transform", language: "javascript", expression: "return 1;" }],
  });
  owner.allowed_workflows = [workflow_id];
  const decision = await can(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    principal: owner,
    permission: "workflow:run",
    resource: { type: "workflow", id: workflow_id },
  });
  expect(decision.allow).toBe(true);
  if (
    !decision.allow ||
    !decision.source ||
    decision.source === "credential_ceiling" ||
    decision.source === "operator_boundary"
  ) {
    throw new Error("Expected an allowed workflow permission decision with a granting source");
  }
  const proof = await captureWorkflowPermission(ctx.testDb.db, owner, workflow_id, decision);
  if (!proof) throw new Error("Expected permission evidence for the allowed workflow decision");
  expect(proof.source).toBe(decision.source);
  const caller = callerFromPrincipal(owner, ctx.tenantId);
  expect(matchingWorkflowPermission(proof, caller, workflow_id)).toEqual(proof);
  expect(matchingWorkflowPermission(proof, caller, nextUuid())).toBeNull();
  expect(
    matchingWorkflowPermission(
      proof,
      caller ? { ...caller, tenantId: nextUuid() } : null,
      workflow_id,
    ),
  ).toBeNull();
  expect(
    matchingWorkflowPermission(
      proof,
      caller ? { ...caller, principalId: nextUuid() } : null,
      workflow_id,
    ),
  ).toBeNull();
  expect(
    await captureWorkflowPermission(ctx.testDb.db, owner, workflow_id, {
      allow: false,
      source: "credential_ceiling",
    }),
  ).toBeNull();
  const authorization = authorizationContextFromPrincipal(owner, proof, workflow_id);
  expect(authorization?.workflow_permission).toEqual(proof);
  expect(
    authorizationContextFromPrincipal(owner, proof, nextUuid())?.workflow_permission,
  ).toBeUndefined();
  await ctx.testDb.db
    .update(apiKeys)
    .set({ revoked_at: new Date(FROZEN_NOW) })
    .where(and(eq(apiKeys.tenant_id, ctx.tenantId), eq(apiKeys.id, key.id)));
  await expect(
    rehydrateExecutionPrincipal(ctx.testDb.db, caller, authorization, new Date(FROZEN_NOW)),
  ).rejects.toMatchObject({ code: "execution_authentication_unavailable" });
});

test("the first starting permission proof is immutable and never backfills a started run", async () => {
  const { owner } = await keyPrincipal("permission-replay");
  const { workflow_id, version_id } = await createWorkflowRow(ctx, {
    name: "Permission replay",
    steps: [{ id: "result", kind: "transform", language: "javascript", expression: "return 1;" }],
  });
  owner.allowed_workflows = [workflow_id];
  const caller = callerFromPrincipal(owner, ctx.tenantId);
  if (!caller) throw new Error("caller fixture missing");
  const decision = await can(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    principal: owner,
    permission: "workflow:run",
    resource: { type: "workflow", id: workflow_id },
  });
  const proof = await captureWorkflowPermission(
    ctx.testDb.db,
    owner,
    workflow_id,
    decision,
    "start",
  );
  if (!proof) throw new Error("permission fixture missing");
  const create = () =>
    createExecution(ctx.testDb.db, {
      tenant_id: ctx.tenantId,
      workflow_id,
      workflow_version_id: version_id,
      source_kind: "saved",
      source_ref: null,
      request_source: "api",
      input: null,
      caller_context: caller,
      authorization_context: authorizationContextFromPrincipal(owner),
    });
  const execution_id = await create();
  const read = async (id: string) =>
    (
      await ctx.testDb.db
        .select()
        .from(executions)
        .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, id)))
    )[0]?.authorization_context?.workflow_permission;
  await recordStartingWorkflowPermission(
    ctx.testDb.db,
    execution_id,
    { ...caller, principalId: nextUuid() },
    proof,
  );
  expect(await read(execution_id)).toBeUndefined();
  await recordStartingWorkflowPermission(ctx.testDb.db, execution_id, caller, proof);
  expect(await read(execution_id)).toEqual(proof);
  await recordStartingWorkflowPermission(ctx.testDb.db, execution_id, caller, {
    ...proof,
    source: "group",
  });
  expect(await read(execution_id)).toEqual(proof);
  const historical_id = await create();
  await ctx.testDb.db
    .update(executions)
    .set({ status: "running", started_at: new Date(FROZEN_NOW) })
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, historical_id)));
  await recordStartingWorkflowPermission(ctx.testDb.db, historical_id, caller, proof);
  expect(await read(historical_id)).toBeUndefined();
});
