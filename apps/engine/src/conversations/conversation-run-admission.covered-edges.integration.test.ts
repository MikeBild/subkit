import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  fileLinks,
  files,
  toolApprovals,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { databaseNow } from "../test-helpers/database-clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import {
  ASK_FIRST,
  ASK_HELD,
  authorityOf,
  draftTargeting,
  type Fixture,
  observe,
  RUN_HELD,
  RUN_LIVE,
  revokeAuthorities,
  skipAudits,
  startFast,
  startGeneric,
  startSynthetic,
  toolCalls,
  withAuthorityRevokedAfterCoverageRead,
} from "./conversation-run-admission-covered-fixtures.ts";
import {
  actorId,
  fixture,
  remote,
  tdb,
  useConversationRunAdmissionSetup,
} from "./conversation-run-admission-fixtures.ts";
import { loadRunCoverage } from "./tools/sdk-wrap/invoke/run-coverage.ts";

const nextUuid = createDeterministicUuidFactory(0x7a5c01);

useConversationRunAdmissionSetup();

function subjectOf(f: Fixture) {
  return {
    tenant_id: f.tenant.id,
    workflow_id: f.workflow.id,
    execution_environment: "dev" as const,
  };
}

async function executionDataFile(f: Fixture): Promise<{ $file: string }> {
  const [file] = await tdb.db
    .insert(files)
    .values({
      tenant_id: f.tenant.id,
      status: "ready",
      filename: "earlier-run.json",
      storage_uri: "memory://earlier-run.json",
      size_bytes: 64,
    })
    .returning();
  if (!file) throw new Error("missing file");
  await tdb.db.insert(fileLinks).values({
    tenant_id: f.tenant.id,
    file_id: file.id,
    resource_type: "workflow_run",
    resource_id: nextUuid(),
    role: "execution_data",
  });
  return { $file: `fid_${file.id}` };
}

describe("execution-data transfer asks in ask although an authority covers the run", () => {
  test("generic", async () => {
    const f = await fixture({ maxRuns: 2 });
    const attachment = await executionDataFile(f);
    expect(await observe(f, () => startGeneric(f, true, {}, { input: { attachment } }))).toEqual(
      ASK_FIRST,
    );
    expect(await f.reserved()).toBe(0);
  });

  test("synthetic", async () => {
    const f = await fixture({ maxRuns: 2 });
    const attachment = await executionDataFile(f);
    expect(await observe(f, () => startSynthetic(f, true, {}, { attachment }))).toEqual(ASK_HELD);
    expect(await f.reserved()).toBe(0);
    expect(await skipAudits(f)).toHaveLength(0);
  });
});

describe("generic run_workflow resolves the same run the tool will start", () => {
  test("without an environment the workflow's own environment is covered", async () => {
    const f = await fixture({ maxRuns: 2 });
    expect(await observe(f, () => startGeneric(f, true, {}, { environment: undefined }))).toEqual(
      RUN_LIVE,
    );
  });

  test("an authority for prod does not cover the default dev start", async () => {
    const f = await fixture({ maxRuns: 2, environment: "prod" });
    expect(await observe(f, () => startGeneric(f, true, {}, { environment: undefined }))).toEqual(
      ASK_FIRST,
    );
  });

  test("an invalid environment is never covered and nothing runs", async () => {
    const f = await fixture({ maxRuns: 2 });
    const before = remote.callCount();
    await startGeneric(f, true, {}, { environment: "staging" });
    expect(remote.callCount()).toBe(before);
    expect(await f.rows()).toHaveLength(0);
    expect(await f.reserved()).toBe(0);
    expect(await skipAudits(f)).toHaveLength(0);
  });

  test("the active target without a workflow argument is covered", async () => {
    const f = await fixture({ maxRuns: 2 });
    expect(
      await observe(f, () => startGeneric(f, true, {}, { workflow: undefined }, draftTargeting(f))),
    ).toEqual(RUN_LIVE);
    expect(await skipAudits(f)).toHaveLength(1);
  });

  test("no workflow argument and no target is not covered and nothing runs", async () => {
    const f = await fixture({ maxRuns: 2 });
    await startGeneric(f, true, {}, { workflow: undefined });
    expect(await f.rows()).toHaveLength(0);
    expect(await f.reserved()).toBe(0);
  });
});

describe("a direct MCP tool call never gets the covered skip", () => {});

describe("authority revoked between the coverage read and admission", () => {
  async function nothingClaimed(f: Fixture) {
    expect(await f.reserved()).toBe(0);
    expect(await skipAudits(f)).toHaveLength(0);
    for (const call of await toolCalls(f)) {
      expect(JSON.stringify(call.confirmation_data ?? {})).not.toContain("covering_authority_id");
    }
  }

  test("fast path: the run ends held", async () => {
    const f = await fixture({ maxRuns: 2 });
    expect(
      await withAuthorityRevokedAfterCoverageRead(() => observe(f, () => startFast(f, true))),
    ).toEqual(RUN_HELD);
    await nothingClaimed(f);
  });

  test("synthetic: the held preview opens the held-writes approval", async () => {
    const f = await fixture({ maxRuns: 2 });
    expect(
      await withAuthorityRevokedAfterCoverageRead(() => observe(f, () => startSynthetic(f, true))),
    ).toEqual(ASK_HELD);
    await nothingClaimed(f);
    const approvals = await tdb.db
      .select()
      .from(toolApprovals)
      .where(eq(toolApprovals.tenant_id, f.tenant.id));
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.tool).toBe(`wf_${f.workflow.slug}`);
  });

  test("generic: the run ends held", async () => {
    const f = await fixture({ maxRuns: 2 });
    expect(
      await withAuthorityRevokedAfterCoverageRead(() => observe(f, () => startGeneric(f, true))),
    ).toEqual(RUN_HELD);
    await nothingClaimed(f);
  });

  test("generic with an expected version: the run is refused", async () => {
    const f = await fixture({ maxRuns: 2 });
    const before = remote.callCount();
    const started = await withAuthorityRevokedAfterCoverageRead(() =>
      startGeneric(f, true, {}, { expected_workflow_version_id: f.version.id }),
    );
    expect(started.asked).toBe(false);
    expect(started.data).toMatchObject({ status: "failed" });
    expect(remote.callCount()).toBe(before);
    expect(await f.rows()).toHaveLength(0);
    await nothingClaimed(f);
  });
});

describe("coverage is the admission decision, read before the gate", () => {
  test("only ask reads coverage, and only the exact run is covered", async () => {
    const f = await fixture({ maxRuns: 1 });
    const subject = subjectOf(f);
    expect(await loadRunCoverage(tdb.db, true, () => subject)).toEqual({
      covered: true,
      authority_id: authorityOf(f).id,
      environment: "dev",
    });
    for (const ask of [false]) {
      expect(await loadRunCoverage(tdb.db, ask, () => subject)).toEqual({ covered: false });
    }
    for (const changed of [
      { execution_environment: "prod" as const },
      { hold_writes: true },
      { workflow_version_id: nextUuid() },
      { workflow_id: nextUuid() },
      { tenant_id: nextUuid() },
    ]) {
      expect(await loadRunCoverage(tdb.db, true, () => ({ ...subject, ...changed }))).toEqual({
        covered: false,
      });
    }
    expect(await loadRunCoverage(tdb.db, true, () => null)).toEqual({ covered: false });
    expect(
      await loadRunCoverage(tdb.db, true, () => {
        throw new Error("unresolvable");
      }),
    ).toEqual({ covered: false });
    expect(await f.reserved()).toBe(0);
  });

  test("an exhausted authority no longer covers", async () => {
    const f = await fixture({ maxRuns: 1 });
    expect(await observe(f, () => startSynthetic(f, true))).toEqual(RUN_LIVE);
    expect(await loadRunCoverage(tdb.db, true, () => subjectOf(f))).toEqual({ covered: false });
  });

  test("a revoked authority no longer covers", async () => {
    const f = await fixture({ maxRuns: 1 });
    await revokeAuthorities(f.tenant.id);
    expect(await loadRunCoverage(tdb.db, true, () => subjectOf(f))).toEqual({ covered: false });
  });

  test("a newer workflow version is not covered by the old authority", async () => {
    const f = await fixture({ maxRuns: 1 });
    const [next] = await tdb.db
      .insert(workflowVersions)
      .values({
        tenant_id: f.tenant.id,
        workflow_id: f.workflow.id,
        version: 2,
        dag: { ...f.definition, description: "New revision requires its own decision" },
      })
      .returning();
    if (!next) throw new Error("missing next version");
    await tdb.db
      .update(workflows)
      .set({ current_version_id: next.id })
      .where(and(eq(workflows.tenant_id, f.tenant.id), eq(workflows.id, f.workflow.id)));
    expect(await loadRunCoverage(tdb.db, true, () => subjectOf(f))).toEqual({ covered: false });
    expect(await observe(f, () => startSynthetic(f, true))).toEqual(ASK_HELD);
  });

  test("an archived workflow is not covered", async () => {
    const f = await fixture({ maxRuns: 1 });
    await tdb.db
      .update(workflows)
      .set({ lifecycle: "archived" })
      .where(and(eq(workflows.tenant_id, f.tenant.id), eq(workflows.id, f.workflow.id)));
    expect(await loadRunCoverage(tdb.db, true, () => subjectOf(f))).toEqual({ covered: false });
  });

  test("an inherited authority counts as covering, as it does for admission", async () => {
    const f = await fixture({ maxRuns: 2 });
    const parent = authorityOf(f);
    const now = await databaseNow(tdb.db);
    const [child] = await tdb.db
      .insert(workflowExecutionAuthorities)
      .values({
        tenant_id: parent.tenant_id,
        workflow_id: parent.workflow_id,
        workflow_version_id: parent.workflow_version_id,
        effect_manifest_digest: parent.effect_manifest_digest,
        effect_manifest: parent.effect_manifest,
        execution_environment: parent.execution_environment,
        target_constraints: parent.target_constraints,
        valid_from: new Date(now.getTime() - 1_000),
        valid_until: parent.valid_until,
        max_runs: 1,
        created_by: actorId,
        inherited_from: parent.id,
        approved_manifest: parent.effect_manifest,
      })
      .returning();
    if (!child) throw new Error("missing inherited authority");
    await tdb.db
      .update(workflowExecutionAuthorities)
      .set({ revoked_at: now, revoked_by: actorId, superseded_by: child.id })
      .where(
        and(
          eq(workflowExecutionAuthorities.tenant_id, f.tenant.id),
          eq(workflowExecutionAuthorities.id, parent.id),
        ),
      );
    expect(await loadRunCoverage(tdb.db, true, () => subjectOf(f))).toEqual({
      covered: true,
      authority_id: child.id,
      environment: "dev",
    });
    const before = remote.callCount();
    expect((await startSynthetic(f, true)).asked).toBe(false);
    expect(remote.callCount() - before).toBe(1);
    expect((await f.rows())[0]).toMatchObject({
      hold_writes: false,
      execution_authority_id: child.id,
    });
    expect((await skipAudits(f))[0]?.metadata).toMatchObject({ covering_authority_id: child.id });
  });
});
