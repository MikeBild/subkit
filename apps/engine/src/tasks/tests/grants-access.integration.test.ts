import { afterAll, beforeAll, expect, test } from "bun:test";
import { connectors } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import {
  grantWorkflowAuthorityLocked,
  lockLiveSession,
  requireHumanSession,
  revokeWorkflowAuthorityLocked,
} from "../../workflows/execution-authorities.ts";
import {
  grantTaskAuthority,
  listTaskGrants,
  previewTaskGrant,
  revokeTaskAuthority,
} from "../grants.ts";
import { failureCode, taskGrantFixtures } from "./grants-fixtures.ts";

const nextUuid = createDeterministicUuidFactory(0x7a5c09);

let ctx: TestDb;

const f = taskGrantFixtures({
  get ctx() {
    return ctx;
  },
});

beforeAll(async () => {
  ctx = await createTestDb("task_grants_access");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function scenario() {
  const tenant = await f.tenant();
  const owner = await f.person(tenant.id, "member");
  const admin = await f.person(tenant.id, "admin");
  const workflow = await f.workflow(tenant.id);
  const task = await f.task(tenant.id, owner.user.id, [workflow.id]);
  return { tenant, owner, admin, workflow, task };
}

test("a member without task:grant is refused for grant and revoke", async () => {
  const s = await scenario();
  const reader = await f.person(s.tenant.id, ["task:read", "workflow:read", "workflow:write"]);
  const own = await f.task(s.tenant.id, reader.user.id, [s.workflow.id]);
  const input = await f.reviewed(own.id, reader);
  expect(await failureCode(grantTaskAuthority(own.id, input, reader.context))).toBe(
    "task_grant_permission_denied",
  );
  const granted = await grantTaskAuthority(own.id, input, s.admin.context);
  expect(await failureCode(revokeTaskAuthority(own.id, granted.grant.id, reader.context))).toBe(
    "task_grant_permission_denied",
  );
  expect((await f.authorities(s.tenant.id)).filter((row) => !row.revoked_at)).toHaveLength(1);
});

test("the background principal of a task run is refused for grant and revoke", async () => {
  const s = await scenario();
  const input = await f.reviewed(s.task.id, s.owner);
  const granted = await grantTaskAuthority(s.task.id, input, s.owner.context);
  const { session_id: _session, ...identity } = s.owner.principal;
  const background = {
    ...s.owner.context,
    principal: {
      ...identity,
      provider: "task",
      auth_source: {
        kind: "task_run" as const,
        task_id: s.task.id,
        task_run_id: nextUuid(),
        grant_id: granted.grant.id,
      },
      allowed_workflows: [s.workflow.id],
      allowed_connectors: [],
    },
  };
  expect(
    await failureCode(grantTaskAuthority(s.task.id, { ...input, max_runs: 9 }, background)),
  ).toBe("human_session_required");
  expect(await failureCode(revokeTaskAuthority(s.task.id, granted.grant.id, background))).toBe(
    "human_session_required",
  );
  const withSession = {
    ...background,
    principal: { ...background.principal, session_id: s.owner.session.id },
  };
  expect(
    await failureCode(grantTaskAuthority(s.task.id, { ...input, max_runs: 9 }, withSession)),
  ).toBe("human_session_required");
  expect(await listTaskGrants(s.task.id, s.owner.context)).toHaveLength(1);
});

test("a person without workflow:write can still revoke a grant and its authorities", async () => {
  const s = await scenario();
  const grantor = await f.person(s.tenant.id, ["task:grant", "task:read", "workflow:read"]);
  const own = await f.task(s.tenant.id, grantor.user.id, [s.workflow.id]);
  const granted = await grantTaskAuthority(
    own.id,
    await f.reviewed(own.id, s.admin),
    s.admin.context,
  );
  const [authority_id] = granted.grant.workflow_authority_ids;
  expect(authority_id).toBeDefined();
  const result = await revokeTaskAuthority(own.id, granted.grant.id, grantor.context);
  expect(result.revoked_workflow_authority_ids).toEqual([authority_id as string]);
  const [row] = await f.authorities(s.tenant.id);
  expect(row?.revoked_by).toBe(grantor.user.id);
});

test("an owner without workflow:read sees no name, effect or digest and gets no co-grant", async () => {
  const s = await scenario();
  const blind = await f.person(s.tenant.id, ["task:grant", "task:read", "workflow:write"]);
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: s.tenant.id,
      slug: "hidden-connector",
      display_name: "Hidden connector",
      driver: "http",
    })
    .returning();
  if (!connector) throw new Error("missing connector fixture");
  const own = await f.task(s.tenant.id, blind.user.id, [s.workflow.id], {
    connector_ids: [connector.id],
  });
  const preview = await previewTaskGrant(own.id, blind.context);
  expect(preview.workflows).toEqual([
    {
      workflow_id: s.workflow.id,
      workflow_version_id: null,
      name: null,
      effect_manifest_digest: null,
      effect_manifest: null,
      blocked_reason: "workflow_not_readable",
      covering_authority: null,
      may_grant: false,
    },
  ]);
  expect(preview.connectors).toEqual([{ connector_id: connector.id, name: null, access: "none" }]);
  const result = await grantTaskAuthority(own.id, await f.reviewed(own.id, blind), blind.context);
  expect(result.workflows[0]).toMatchObject({
    outcome: "not_granted",
    reason: "workflow_not_readable",
  });
  expect(await f.authorities(s.tenant.id)).toHaveLength(0);
  const asAdmin = await previewTaskGrant(own.id, s.admin.context);
  expect(asAdmin.workflows[0]).toMatchObject({ blocked_reason: null, may_grant: true });
  expect(asAdmin.workflows[0]?.name).not.toBeNull();
  expect(asAdmin.connectors).toEqual([
    { connector_id: connector.id, name: "Hidden connector", access: null },
  ]);
  expect(asAdmin.live_grant?.id).toBe(result.grant.id);
});

test("preview, list, grant and revoke from another tenant find nothing", async () => {
  const s = await scenario();
  const granted = await grantTaskAuthority(
    s.task.id,
    await f.reviewed(s.task.id, s.owner),
    s.owner.context,
  );
  const elsewhere = await f.tenant();
  const outsider = await f.person(elsewhere.id, "admin");
  expect(await failureCode(previewTaskGrant(s.task.id, outsider.context))).toBe("task_not_found");
  expect(await failureCode(listTaskGrants(s.task.id, outsider.context))).toBe("task_not_found");
  expect(
    await failureCode(
      grantTaskAuthority(s.task.id, await f.reviewed(s.task.id, s.owner), outsider.context),
    ),
  ).toBe("task_not_found");
  expect(
    await failureCode(revokeTaskAuthority(s.task.id, granted.grant.id, outsider.context)),
  ).toBe("task_not_found");
  const stranger = await f.person(s.tenant.id, "member");
  expect(await failureCode(listTaskGrants(s.task.id, stranger.context))).toBe("task_not_found");
  expect((await listTaskGrants(s.task.id, s.admin.context)).map((grant) => grant.id)).toEqual([
    granted.grant.id,
  ]);
});

test("the locked workflow seams refuse a proof from another transaction or another person", async () => {
  const s = await scenario();
  const input = await f.reviewed(s.task.id, s.owner);
  const body = {
    workflow_version_id: s.workflow.version_id,
    expected_manifest_digest: input.expected_workflow_digests[s.workflow.id] as string,
    execution_environment: "dev" as const,
    valid_from: new Date(FROZEN_NOW).toISOString(),
    valid_until: null,
    max_runs: null,
  };
  const session = await requireHumanSession(s.owner.context);
  const stale = await ctx.db.transaction((tx) => lockLiveSession(tx, session));
  expect(
    await failureCode(
      ctx.db.transaction((tx) =>
        grantWorkflowAuthorityLocked(tx, stale, s.workflow.id, body, s.owner.principal),
      ),
    ),
  ).toBe("human_session_required");
  expect(
    await failureCode(
      ctx.db.transaction(async (tx) => {
        const proof = await lockLiveSession(tx, session);
        return grantWorkflowAuthorityLocked(tx, proof, s.workflow.id, body, s.admin.principal);
      }),
    ),
  ).toBe("human_session_required");
  const forged = { tenant_id: s.tenant.id, user_id: s.owner.user.id } as typeof stale;
  expect(
    await failureCode(
      ctx.db.transaction((tx) =>
        revokeWorkflowAuthorityLocked(tx, forged, s.workflow.id, nextUuid(), s.owner.principal),
      ),
    ),
  ).toBe("human_session_required");
  expect(await f.authorities(s.tenant.id)).toHaveLength(0);
});
