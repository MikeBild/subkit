import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { workflowVersions } from "../../../db/schema/index.ts";
import { withSelfHostedDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { makeTestPrincipal } from "../../../tools/tests/_helpers.ts";
import { saveWorkflowDraft } from "../../../workflows/drafts.ts";
import { createWorkflow } from "../../../workflows/service.ts";
import { parsePackageWorkflowNote } from "../../../workflows/service-package-provenance.ts";
import { workflowDefFromDraft } from "../../persistence/commit-workflow.ts";
import { applyWorkflowPatchToDraft } from "../edit-workflow-patch.ts";
import { fetchConnectorSelfDescriptionTool } from "../fetch-connector-self-description.ts";
import { manageServicePackageWorkflowTool } from "../manage-service-package-workflow.ts";
import { prepareServicePackageWorkflowTool } from "../prepare-service-package-workflow.ts";
import {
  ctx,
  FOREIGN_CONNECTOR_ID,
  makeCtx,
  nextUuid,
  package_connector,
  packageFetch,
  tenant_id,
  useFetchConnectorSelfDescriptionSetup,
} from "./fetch-connector-self-description-fixtures.ts";

useFetchConnectorSelfDescriptionSetup();

describe("fetch_connector_self_description", () => {
  test("prepares a verified package workflow as an inactive draft", async () => {
    const ctx = makeCtx(package_connector);
    const result = await withSelfHostedDriverFetchForTests(packageFetch(), () =>
      prepareServicePackageWorkflowTool.execute(ctx, {
        workflow_slug: "support-preview-status",
        prefix: "support-preview",
      }),
    );
    expect(result.ok).toBe(true);
    const data = result.data as {
      workflow: { name: string; slug: string; step_count: number };
      install_state: string;
      review_required: boolean;
    };
    expect(data.workflow).toMatchObject({
      slug: "support-preview-status",
      name: "Read status",
      step_count: 1,
    });
    expect(data.workflow).toHaveProperty("input_schema");
    expect(data.install_state).toBe("inactive_draft");
    expect(data.review_required).toBe(true);
    expect(ctx.getDraft().workflow.slug).toBe("support-preview-status");
    expect(ctx.getDraft().workflow.steps[0]?.connector_id).toBe(package_connector);
    const source = ctx.getDraft().workflow.service_package_source;
    expect(source).toMatchObject({
      package_id: "com.example.service",
      package_version: "2.0.0",
      connector_id: package_connector,
      workflow_slug: "support-preview-status",
      prefix: "support-preview",
    });
    if (!source) throw new Error("service package provenance was not retained in the draft");
    const saved = await saveWorkflowDraft(
      {
        tenant_id,
        actor_id: null,
        request_source: "tool-chain",
        def: {
          name: ctx.getDraft().workflow.name,
          slug: ctx.getDraft().workflow.slug,
          steps: ctx.getDraft().workflow.steps,
        },
        service_package_source: source,
      },
      ctx.db,
    );
    if (!saved.draft) throw new Error(saved.errors.join(", "));
    const [version] = await ctx.db
      .select({ note: workflowVersions.note })
      .from(workflowVersions)
      .where(eq(workflowVersions.id, saved.draft.version_id))
      .limit(1);
    expect(parsePackageWorkflowNote(version?.note ?? null)).toMatchObject({
      package_id: "com.example.service",
      package_version: "2.0.0",
      connector_id: package_connector,
      workflow_slug: "support-preview-status",
      prefix: "support-preview",
      installed_hash: saved.draft.digest,
    });
  });

  test("keeps caller binding and provenance for a caller-bound package installed with its default prefix", async () => {
    const principal = {
      ...makeTestPrincipal({
        tenant_id,
        id: "00000000-0000-4000-8000-000000000046",
        roles: ["admin"],
      }),
      auth_source: { kind: "browser_session" as const, session_id: nextUuid() },
    };
    const installContext = makeCtx(package_connector, undefined, principal);
    const fixture = {
      callerBound: true,
      prefixDefault: "subkit-support",
      expectedPrefix: "subkit-support",
      workflowSlug: "subkit-support-status",
    };
    const installed = await withSelfHostedDriverFetchForTests(packageFetch(fixture), () =>
      prepareServicePackageWorkflowTool.execute(installContext, {
        workflow_slug: "subkit-support-status",
      }),
    );
    if (!installed.ok) throw new Error(JSON.stringify(installed));
    const draft = installContext.getDraft().workflow as unknown as Record<string, unknown>;
    expect(draft.required_caller_kind).toBe("user");
    expect(draft.tool_effect).toBe("read");
    expect(draft.timeout_ms).toBe(30_000);
    expect(installContext.getDraft().workflow.service_package_source?.prefix).toBe(
      "subkit-support",
    );
    const source = installContext.getDraft().workflow.service_package_source;
    if (!source) throw new Error("service package provenance was not retained in the draft");
    const saved = await saveWorkflowDraft(
      {
        tenant_id,
        actor_id: principal.id,
        actor_type: "user",
        request_source: "tool-chain",
        def: workflowDefFromDraft(installContext.getDraft().workflow),
        service_package_source: source,
      },
      ctx.db,
    );
    if (!saved.draft) throw new Error(saved.errors.join(", "));
    expect(saved.draft.definition.required_caller_kind).toBe("user");
    const [version] = await ctx.db
      .select({ note: workflowVersions.note })
      .from(workflowVersions)
      .where(eq(workflowVersions.id, saved.draft.version_id))
      .limit(1);
    expect(parsePackageWorkflowNote(version?.note ?? null)).toMatchObject({
      prefix: "subkit-support",
      installed_hash: saved.draft.digest,
    });

    const updateContext = makeCtx(package_connector, undefined, principal);
    const updated = await withSelfHostedDriverFetchForTests(
      packageFetch({ ...fixture, packageVersion: "2.1.0", workflowPath: "/v2/status" }),
      () =>
        manageServicePackageWorkflowTool.execute(updateContext, {
          action: "update",
          workflow_id: saved.draft.workflow_id,
          expected_version: 1,
        }),
    );
    if (!updated.ok) throw new Error(JSON.stringify(updated));
    expect(
      (updateContext.getDraft().workflow as unknown as Record<string, unknown>)
        .required_caller_kind,
    ).toBe("user");
  });

  test("refuses a workflow artifact that differs from the manifest checksum", async () => {
    const result = await withSelfHostedDriverFetchForTests(
      packageFetch({ workflowsManifestHash: "0".repeat(64) }),
      () =>
        fetchConnectorSelfDescriptionTool.execute(makeCtx(package_connector), {
          kind: "package",
          prefix: "support-preview",
        }),
    );
    expect(result.ok).toBe(true);
    const data = result.data as {
      artifacts: Array<{ name: string }>;
      errors: Array<{ name: string }>;
    };
    expect(data.artifacts.map((artifact) => artifact.name)).not.toContain("workflows");
    expect(data.errors.map((error) => error.name)).toContain("workflows");
  });

  test("refuses draft patches that rewrite the service package source", async () => {
    const toolCtx = makeCtx(package_connector);
    const prepared = await withSelfHostedDriverFetchForTests(
      packageFetch({ workflowSlug: "support-patch-guard" }),
      () =>
        prepareServicePackageWorkflowTool.execute(toolCtx, {
          workflow_slug: "support-patch-guard",
          prefix: "support-preview",
        }),
    );
    if (!prepared.ok) throw new Error(JSON.stringify(prepared));
    const before = toolCtx.getDraft().workflow.service_package_source;
    const patched = await applyWorkflowPatchToDraft(toolCtx, [
      { op: "replace", path: "/service_package_source/connector_id", value: FOREIGN_CONNECTOR_ID },
    ]);
    expect(patched.ok).toBe(false);
    expect(toolCtx.getDraft().workflow.service_package_source).toEqual(before);
  });

  test("leaves a workflow without package provenance unchanged on update and archive", async () => {
    const principal = {
      ...makeTestPrincipal({
        tenant_id,
        id: "00000000-0000-4000-8000-000000000047",
        roles: ["admin"],
      }),
      auth_source: { kind: "browser_session" as const, session_id: nextUuid() },
    };
    const created = await createWorkflow(
      {
        tenant_id,
        actor_id: null,
        def: {
          name: "Built-in support",
          slug: "support-legacy-flow",
          steps: [
            {
              kind: "request",
              id: "read-status",
              connector_id: package_connector,
              method: "GET",
              path: "/v1/status",
            },
          ],
        },
      },
      ctx.db,
    );
    if ("errors" in created) throw new Error(created.errors.join(", "));
    for (const action of ["update", "archive"] as const) {
      const result = await withSelfHostedDriverFetchForTests(
        packageFetch({ workflowSlug: "support-legacy-flow" }),
        () =>
          manageServicePackageWorkflowTool.execute(
            makeCtx(package_connector, undefined, principal),
            { action, workflow_id: created.workflow.id, expected_version: 1 },
          ),
      );
      expect(result).toMatchObject({
        ok: false,
        error_code: "service_package_workflow_not_managed",
      });
    }
  });

  test("repeated package setup recognizes an identical saved workflow without rewriting it", async () => {
    const created = await createWorkflow(
      {
        tenant_id,
        actor_id: null,
        def: {
          name: "Read status",
          slug: "support-idempotent-status",
          steps: [
            {
              kind: "request",
              id: "read-status",
              connector_id: package_connector,
              method: "GET",
              path: "/v1/status",
            },
          ],
        },
      },
      ctx.db,
    );
    if ("errors" in created) throw new Error(created.errors.join(", "));

    const toolCtx = makeCtx(package_connector);
    const repeated = await withSelfHostedDriverFetchForTests(
      packageFetch({ workflowSlug: "support-idempotent-status" }),
      () =>
        prepareServicePackageWorkflowTool.execute(toolCtx, {
          workflow_slug: "support-idempotent-status",
          prefix: "support-preview",
        }),
    );

    expect(repeated.ok).toBe(true);
    expect(repeated.data).toMatchObject({
      workflow_id: created.workflow.id,
      install_state: "already_matches_package",
      review_required: false,
    });
    expect(toolCtx.getDraft().workflow.steps).toHaveLength(0);

    const [savedVersion] = await ctx.db
      .select({ id: workflowVersions.id })
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, created.workflow.id))
      .limit(1);
    if (!savedVersion) throw new Error("created workflow version was not persisted");
    const changedDefinition = {
      name: "Locally changed workflow",
      steps: [{ kind: "wait", id: "wait-local", duration_ms: 1 }],
    };
    await ctx.db
      .update(workflowVersions)
      .set({ dag: changedDefinition })
      .where(eq(workflowVersions.id, savedVersion.id));

    const conflict = await withSelfHostedDriverFetchForTests(
      packageFetch({ workflowSlug: "support-idempotent-status" }),
      () =>
        prepareServicePackageWorkflowTool.execute(makeCtx(package_connector), {
          workflow_slug: "support-idempotent-status",
          prefix: "support-preview",
        }),
    );
    expect(conflict).toMatchObject({ ok: false, error_code: "workflow_already_exists" });
    const [unchanged] = await ctx.db
      .select({ dag: workflowVersions.dag })
      .from(workflowVersions)
      .where(eq(workflowVersions.id, savedVersion.id))
      .limit(1);
    expect(unchanged?.dag).toEqual(changedDefinition);
  });

  test("updates an unchanged installed service workflow into a review draft", async () => {
    const principal = {
      ...makeTestPrincipal({
        tenant_id,
        id: "00000000-0000-4000-8000-000000000044",
        roles: ["admin"],
      }),
      auth_source: { kind: "browser_session" as const, session_id: nextUuid() },
    };
    const installContext = makeCtx(package_connector, undefined, principal);
    const installed = await withSelfHostedDriverFetchForTests(
      packageFetch({ workflowSlug: "support-update-flow" }),
      () =>
        prepareServicePackageWorkflowTool.execute(installContext, {
          workflow_slug: "support-update-flow",
          prefix: "support-preview",
        }),
    );
    if (!installed.ok) throw new Error(JSON.stringify(installed));
    const source = installContext.getDraft().workflow.service_package_source;
    if (!source) throw new Error("service package provenance was not retained in the draft");
    const saved = await saveWorkflowDraft(
      {
        tenant_id,
        actor_id: principal.id,
        actor_type: "user",
        request_source: "tool-chain",
        def: {
          name: installContext.getDraft().workflow.name,
          slug: installContext.getDraft().workflow.slug,
          steps: installContext.getDraft().workflow.steps,
        },
        service_package_source: source,
      },
      ctx.db,
    );
    if (!saved.draft) throw new Error(saved.errors.join(", "));
    const [savedVersion] = await ctx.db
      .select({ note: workflowVersions.note })
      .from(workflowVersions)
      .where(eq(workflowVersions.id, saved.draft.version_id))
      .limit(1);
    if (!parsePackageWorkflowNote(savedVersion?.note ?? null)) {
      throw new Error(`workflow package provenance missing: ${savedVersion?.note ?? "null"}`);
    }

    const updateContext = makeCtx(package_connector, undefined, principal);
    const updated = await withSelfHostedDriverFetchForTests(
      packageFetch({
        packageVersion: "2.1.0",
        workflowSlug: "support-update-flow",
        workflowPath: "/v2/status",
      }),
      () =>
        manageServicePackageWorkflowTool.execute(updateContext, {
          action: "update",
          workflow_id: saved.draft.workflow_id,
          expected_version: 1,
        }),
    );
    if (!updated.ok) throw new Error(JSON.stringify(updated));
    expect(updated).toMatchObject({
      ok: true,
      data: {
        workflow_id: saved.draft.workflow_id,
        install_state: "update_draft",
        review_required: true,
      },
    });
    expect(updateContext.getDraft().workflow.steps[0]).toMatchObject({ path: "/v2/status" });
    expect(updateContext.getDraft().workflow.service_package_source).toMatchObject({
      package_version: "2.1.0",
      workflow_slug: "support-update-flow",
      prefix: "support-preview",
    });
    const [stillSaved] = await ctx.db
      .select({ dag: workflowVersions.dag, version: workflowVersions.version })
      .from(workflowVersions)
      .where(eq(workflowVersions.id, saved.draft.version_id))
      .limit(1);
    if (!stillSaved) throw new Error("installed workflow version was not persisted");
    expect(stillSaved.version).toBe(1);
    expect((stillSaved.dag as { steps?: Array<{ path?: string }> }).steps?.[0]?.path).toBe(
      "/v1/status",
    );
  });

  test("archives only unchanged service workflows after a signed-in request", async () => {
    const principal = {
      ...makeTestPrincipal({
        tenant_id,
        id: "00000000-0000-4000-8000-000000000045",
        roles: ["admin"],
      }),
      auth_source: { kind: "browser_session" as const, session_id: nextUuid() },
    };
    const installContext = makeCtx(package_connector, undefined, principal);
    const installed = await withSelfHostedDriverFetchForTests(
      packageFetch({ workflowSlug: "support-archive-flow" }),
      () =>
        prepareServicePackageWorkflowTool.execute(installContext, {
          workflow_slug: "support-archive-flow",
          prefix: "support-preview",
        }),
    );
    if (!installed.ok) throw new Error(JSON.stringify(installed));
    const source = installContext.getDraft().workflow.service_package_source;
    if (!source) throw new Error("service package provenance was not retained in the draft");
    const saved = await saveWorkflowDraft(
      {
        tenant_id,
        actor_id: principal.id,
        actor_type: "user",
        request_source: "tool-chain",
        def: {
          name: installContext.getDraft().workflow.name,
          slug: installContext.getDraft().workflow.slug,
          steps: installContext.getDraft().workflow.steps,
        },
        service_package_source: source,
      },
      ctx.db,
    );
    if (!saved.draft) throw new Error(saved.errors.join(", "));

    const archived = await manageServicePackageWorkflowTool.execute(
      makeCtx(package_connector, undefined, principal),
      {
        action: "archive",
        connector_id: package_connector,
        workflow_id: saved.draft.workflow_id,
        expected_version: 1,
      },
    );
    expect(archived).toMatchObject({
      ok: true,
      data: { lifecycle: "archived", workflow_id: saved.draft.workflow_id },
    });
  });
});
