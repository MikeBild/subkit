import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { sessions, users, workflowsSchedules } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { inspectScheduleAutomation } from "../../scheduler/automation-status.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { withDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import {
  loadContentRevisionReceipts,
  proposeContentPublicationBoundaries,
} from "../../workflows/content-publication-proposal.ts";
import {
  grantWorkflowAuthority,
  previewWorkflowAuthority,
} from "../../workflows/execution-authorities.ts";
import { admitAuthorizedWorkflowExecution } from "../authority-admission.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

const origin = "https://content.example.test";
const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
const other = "00000000-0000-4000-8000-000000000003";
const ra = "00000000-0000-4000-8000-000000000011";
const rb = "00000000-0000-4000-8000-000000000012";
const site = "00000000-0000-4000-8000-000000000021";
let ctx: EngineTestCtx;
let sequence = 0;
beforeAll(async () => {
  ctx = await createEngineCtx("content-authority");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function fixture(loop = false) {
  const db = ctx.testDb.db;
  const workflow = await createWorkflowRow(ctx, {
    name: "Publish project updates",
    slug: `content-publication-${++sequence}`,
    steps: [
      ...(loop
        ? [
            { id: "updates", kind: "loop", over: "$input.items", body: ["update"] },
            {
              id: "update",
              kind: "request",
              method: "PUT",
              url: `${origin}/v1/content/\${item.item_id}/revisions`,
              headers: { "Content-Type": "text/markdown; charset=utf-8" },
              // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow input substitution
              body: "${input.markdown}",
              max_retries: 0,
            },
          ]
        : ["a", "b"].map((key) => ({
            id: `update_${key}`,
            kind: "request",
            method: "PUT",
            url: `${origin}/v1/content/\${input.${key}}/revisions`,
            headers: { "Content-Type": "text/markdown; charset=utf-8" },
            // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow substitution
            body: "${input.markdown}",
            max_retries: 0,
          }))),
      {
        id: "collect",
        kind: "transform",
        depends_on: loop ? ["updates"] : ["update_a", "update_b"],
        expression: loop
          ? "return input.scope.updates.data.map(row => row.update.data.id);"
          : "return input.input.foreign ? [input.input.foreign, input.scope.update_b.data.id] : [input.scope.update_a.data.id, input.scope.update_b.data.id];",
      },
      {
        id: "publish",
        kind: "request",
        method: "POST",
        url: `${origin}/v1/sites/${site}/releases`,
        depends_on: ["collect"],
        headers: { "Content-Type": "application/json" },
        max_retries: 0,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow substitution
        body: { revision_ids: "${scope.collect.data}", reason: "Scheduled update" },
      },
    ],
  });
  const baseInput = {
    a,
    b,
    items: [{ item_id: a }, { item_id: b }],
    markdown: "# Updated project",
  };
  const reviewInput = {
    tenant_id: ctx.tenantId,
    workflow_id: workflow.workflow_id,
    workflow_version_id: workflow.version_id,
    execution_environment: "dev" as const,
  };
  const inspect = () => previewWorkflowAuthority(reviewInput, db);
  const now = await databaseNow(db);
  const [user] = await db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      role_id: await builtinRoleId(db, "admin"),
      email: `content-${sequence}@example.test`,
    })
    .returning();
  if (!user) throw new Error("missing user");
  const [session] = await db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: user.id,
      expires_at: new Date(now.getTime() + 3_600_000),
    })
    .returning();
  if (!session) throw new Error("missing session");
  const identity = { tenant_id: ctx.tenantId, user_id: user.id, session_id: session.id };
  const principal: ResolvedPrincipal = {
    provider: "session",
    kind: "user",
    id: user.id,
    tenant_id: ctx.tenantId,
    roles: ["admin"],
    session_id: session.id,
  };
  const request = new Request("https://example.test/grant", {
    method: "POST",
    headers: {
      cookie: browserSessionCookie(await signBrowserSession(identity)),
      "x-subkit-csrf": await signBrowserCsrf(identity),
    },
  });
  const [schedule] = await db
    .insert(workflowsSchedules)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: workflow.workflow_id,
      cron: "0 9 * * 1",
      execution_mode: "dev",
      input: baseInput,
      admission_hold: {
        reason_code: "execution_authority_unavailable",
        observed_at: now.toISOString(),
      },
    })
    .returning();
  if (!schedule) throw new Error("missing schedule");
  const prepare = () =>
    runExecution({
      db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: workflow.workflow_id },
      input: baseInput,
      options: { execution_mode: "dev", hold_writes: true, principal },
    });
  const grant = async () => {
    const preview = await inspect();
    return grantWorkflowAuthority(
      workflow.workflow_id,
      {
        workflow_version_id: workflow.version_id,
        execution_environment: "dev",
        expected_manifest_digest: preview.digest,
        max_runs: 2,
        valid_from: now.toISOString(),
        valid_until: new Date(now.getTime() + 3_600_000).toISOString(),
      },
      { db, principal, request },
    );
  };
  const run = async (input = baseInput as Record<string, unknown>) => {
    const admitted = await admitAuthorizedWorkflowExecution(
      {
        tenant_id: ctx.tenantId,
        workflow_id: workflow.workflow_id,
        execution_environment: "dev",
        request_source: "scheduler",
        input,
      },
      db,
    );
    return runExecution({
      db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: workflow.workflow_id },
      input,
      options: { existing_execution_id: admitted.execution_id, principal },
    });
  };
  return { workflow, reviewInput, baseInput, schedule, inspect, prepare, grant, run };
}

function remoteFixture() {
  let writes = 0;
  let publications = 0;
  const remote = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      writes++;
      if (init?.method === "PUT")
        return Response.json({ id: String(url).includes(a) ? ra : rb }, { status: 201 });
      publications++;
      expect(JSON.parse(String(init?.body)).revision_ids).toEqual([ra, rb]);
      return Response.json({ active: true }, { status: 201 });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  return { remote, writes: () => writes, publications: () => publications };
}

test("held batch -> exact human grant -> scheduler decision resolved -> changing content publishes within limits", async () => {
  const f = await fixture();
  const remote = remoteFixture();
  await withDriverFetchForTests(remote.remote, async () => {
    expect((await f.inspect()).eligible_for_repeated_runs).toBe(false);
    const prepared = await f.prepare();
    expect(prepared.status, JSON.stringify(prepared.steps)).toBe("succeeded");
    expect(remote.writes()).toBe(0);
    expect(
      await loadContentRevisionReceipts(ctx.testDb.db, ctx.tenantId, prepared.execution_id),
    ).toEqual([]);
    const reviewed = await f.inspect();
    expect(reviewed.eligible_for_repeated_runs, JSON.stringify(reviewed.manifest.issues)).toBe(
      true,
    );
    expect(
      reviewed.manifest.effects.find((e) => e.step_id === "publish")?.content_publication,
    ).toMatchObject({
      kind: "content_release",
      site_id: site,
      sources: [
        { step_id: "update_a", item_ids: [a] },
        { step_id: "update_b", item_ids: [b] },
      ],
    });
    await f.grant();
    const state = await inspectScheduleAutomation(f.schedule, ctx.testDb.db);
    expect(state.state).toBe("authorized");
    const first = await f.run();
    expect(first.status, JSON.stringify(first.steps)).toBe("succeeded");
    expect(
      (await loadContentRevisionReceipts(ctx.testDb.db, ctx.tenantId, first.execution_id)).length,
    ).toBe(2);
    expect(await loadContentRevisionReceipts(ctx.testDb.db, other, first.execution_id)).toEqual([]);
    const second = await f.run({ ...f.baseInput, markdown: "# Next week's update" });
    expect(second.status, JSON.stringify(second.steps)).toBe("succeeded");
    expect(remote.publications()).toBe(2);
    await expect(f.run()).rejects.toMatchObject({ code: "execution_authority_unavailable" });
  });
});

test("a new item cannot inherit the old grant", async () => {
  const f = await fixture();
  const remote = remoteFixture();
  await withDriverFetchForTests(remote.remote, async () => {
    await f.prepare();
    await f.grant();
    const result = await f.run({ ...f.baseInput, a: other });
    expect(result.status).toBe("failed");
    expect(remote.writes()).toBe(0);
    expect(remote.publications()).toBe(0);
  });
});

test("an authored collector cannot substitute a foreign revision after legitimate writes", async () => {
  const f = await fixture();
  const remote = remoteFixture();
  await withDriverFetchForTests(remote.remote, async () => {
    await f.prepare();
    await f.grant();
    const result = await f.run({ ...f.baseInput, foreign: other });
    expect(result.status).toBe("failed");
    expect(remote.writes()).toBe(2);
    expect(remote.publications()).toBe(0);
  });
});

test("held evidence cannot cross tenant, version or environment", async () => {
  const f = await fixture();
  await f.prepare();
  for (const patch of [
    { tenant_id: other },
    { workflow_version_id: other },
    { execution_environment: "prod" as const },
  ])
    expect(
      await proposeContentPublicationBoundaries(
        { ...f.reviewInput, ...patch },
        ["update_a", "update_b"],
        ctx.testDb.db,
      ),
    ).toEqual({});
});

test("loop instances retain distinct approved members and trusted revision receipts", async () => {
  const f = await fixture(true);
  const remote = remoteFixture();
  await withDriverFetchForTests(remote.remote, async () => {
    const prepared = await f.prepare();
    expect(prepared.status, JSON.stringify(prepared.steps)).toBe("succeeded");
    const review = await f.inspect();
    expect(
      review.eligible_for_repeated_runs,
      JSON.stringify({ issues: review.manifest.issues, steps: prepared.steps }),
    ).toBe(true);
    expect(
      review.manifest.effects.find((e) => e.step_id === "update")?.content_publication,
    ).toMatchObject({
      kind: "content_revision",
      item_ids: [a, b],
    });
    await f.grant();
    const result = await f.run();
    expect(result.status, JSON.stringify(result.steps)).toBe("succeeded");
    expect(remote.publications()).toBe(1);
  });
});
