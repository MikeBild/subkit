import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getCredentialForConnector } from "../../../credentials/service.ts";
import { connectors } from "../../../db/schema/index.ts";
import { getSkill, updateSkill } from "../../../skills/service.ts";
import { withSelfHostedDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { makeTestPrincipal } from "../../../tools/tests/_helpers.ts";
import { enrollServicePackageConnectorTool } from "../enroll-service-package-connector.ts";
import { manageServicePackageSkillTool } from "../manage-service-package-skill.ts";
import { prepareServicePackageWorkflowTool } from "../prepare-service-package-workflow.ts";
import {
  ctx,
  makeCtx,
  nextUuid,
  package_connector,
  packageFetch,
  tenant_id,
  useFetchConnectorSelfDescriptionSetup,
} from "./fetch-connector-self-description-fixtures.ts";

useFetchConnectorSelfDescriptionSetup();

describe("fetch_connector_self_description", () => {
  test("installs a package skill as a connector-scoped draft and is idempotent", async () => {
    const principal = {
      ...makeTestPrincipal({
        tenant_id,
        id: "00000000-0000-4000-8000-000000000042",
        roles: ["admin"],
      }),
      auth_source: { kind: "browser_session" as const, session_id: nextUuid() },
    };
    const toolCtx = makeCtx(package_connector, undefined, principal);
    const installPackage = { packageId: "com.example.install-skill" };
    const result = await withSelfHostedDriverFetchForTests(packageFetch(installPackage), () =>
      manageServicePackageSkillTool.execute(toolCtx, {
        action: "install",
        connector_id: package_connector,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ state: "draft_review_required", skill_version: 1 });
    const skillId = (result.data as { skill_id: string }).skill_id;
    const skill = await getSkill(tenant_id, skillId, ctx.db);
    expect(skill).toMatchObject({
      scope: "connector",
      connector_id: package_connector,
      status: "draft",
      source: "template",
      body: "# Optional service skill\n",
      tags: expect.arrayContaining([
        "subkit-service-package:com.example.install-skill",
        `subkit-service-package-body-sha256:${createHash("sha256").update("# Optional service skill\n").digest("hex")}`,
        `subkit-service-package-content-sha256:${createHash("sha256")
          .update(
            JSON.stringify({
              title: "Example Service",
              description: null,
              body: "# Optional service skill\n",
              doc_refs: ["https://api.acme.test/support/skill.md"],
            }),
          )
          .digest("hex")}`,
      ]),
    });

    const repeated = await withSelfHostedDriverFetchForTests(packageFetch(installPackage), () =>
      manageServicePackageSkillTool.execute(toolCtx, { action: "install" }),
    );
    expect(repeated.ok).toBe(true);
    if (!repeated.ok) return;
    expect(repeated.data).toMatchObject({ skill_id: skillId, state: "current", skill_version: 1 });
  });

  test("concurrent package skill installs create one guide", async () => {
    const principal = {
      ...makeTestPrincipal({
        tenant_id,
        id: "00000000-0000-4000-8000-000000000048",
        roles: ["admin"],
      }),
      auth_source: { kind: "browser_session" as const, session_id: nextUuid() },
    };
    const installPackage = {
      packageId: "com.example.concurrent-skill",
      packageName: "Concurrent Service",
    };
    const results = await withSelfHostedDriverFetchForTests(packageFetch(installPackage), () =>
      Promise.all(
        [0, 1, 2].map(() =>
          manageServicePackageSkillTool.execute(makeCtx(package_connector, undefined, principal), {
            action: "install",
            connector_id: package_connector,
          }),
        ),
      ),
    );
    expect(results.filter((result) => !result.ok)).toEqual([]);
    const ids = new Set(results.map((result) => (result.data as { skill_id: string }).skill_id));
    expect(ids.size).toBe(1);
  });

  test("requires a signed-in person before installing service package content", async () => {
    const toolCtx = makeCtx(package_connector, undefined, {
      ...makeTestPrincipal({ tenant_id }),
      auth_source: {
        kind: "api_key",
        api_key_id: nextUuid(),
        credential_version: "version",
      },
    });
    const result = await manageServicePackageSkillTool.execute(toolCtx, { action: "install" });
    expect(result).toMatchObject({ ok: false, error_code: "user_confirmation_required" });
  });

  test("updates only an unchanged package skill and returns it to draft review", async () => {
    const principal = {
      ...makeTestPrincipal({
        tenant_id,
        id: "00000000-0000-4000-8000-000000000043",
        roles: ["admin"],
      }),
      auth_source: { kind: "browser_session" as const, session_id: nextUuid() },
    };
    const toolCtx = makeCtx(package_connector, undefined, principal);
    const updatePackage = {
      packageId: "com.example.update-skill",
      packageName: "Example Update Service",
    };
    const installed = await withSelfHostedDriverFetchForTests(packageFetch(updatePackage), () =>
      manageServicePackageSkillTool.execute(toolCtx, { action: "install" }),
    );
    if (!installed.ok) throw new Error(JSON.stringify(installed));
    const skillId = (installed.data as { skill_id: string }).skill_id;

    const updated = await withSelfHostedDriverFetchForTests(
      packageFetch({
        ...updatePackage,
        packageVersion: "2.1.0",
        skillBody: "# Updated service skill\n",
      }),
      () =>
        manageServicePackageSkillTool.execute(toolCtx, {
          action: "update",
          skill_id: skillId,
          expected_version: 1,
        }),
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.data).toMatchObject({ skill_version: 2, state: "draft" });
    expect(await getSkill(tenant_id, skillId, ctx.db)).toMatchObject({
      body: "# Updated service skill\n",
      status: "draft",
      tags: expect.arrayContaining([
        "subkit-service-package-version:2.1.0",
        `subkit-service-package-body-sha256:${createHash("sha256").update("# Updated service skill\n").digest("hex")}`,
      ]),
    });

    const repeatedUpdate = await withSelfHostedDriverFetchForTests(
      packageFetch({
        ...updatePackage,
        packageVersion: "2.1.0",
        skillBody: "# Updated service skill\n",
      }),
      () =>
        manageServicePackageSkillTool.execute(toolCtx, {
          action: "update",
          skill_id: skillId,
          expected_version: 2,
        }),
    );
    expect(repeatedUpdate.ok).toBe(true);
    if (repeatedUpdate.ok) {
      expect(repeatedUpdate.data).toMatchObject({ skill_id: skillId, skill_version: 2 });
    }

    const archived = await withSelfHostedDriverFetchForTests(packageFetch(updatePackage), () =>
      manageServicePackageSkillTool.execute(toolCtx, {
        action: "archive",
        skill_id: skillId,
        expected_version: 2,
      }),
    );
    expect(archived.ok).toBe(true);
    expect(await getSkill(tenant_id, skillId, ctx.db)).toMatchObject({
      status: "archived",
      version: 3,
    });
    const repeatedArchive = await manageServicePackageSkillTool.execute(toolCtx, {
      action: "archive",
      skill_id: skillId,
      expected_version: 3,
    });
    expect(repeatedArchive.ok).toBe(true);
    if (repeatedArchive.ok) {
      expect(repeatedArchive.data).toMatchObject({
        skill_id: skillId,
        skill_version: 3,
        state: "archived",
      });
    }
    const reinstalled = await withSelfHostedDriverFetchForTests(
      packageFetch({
        ...updatePackage,
        packageVersion: "2.1.0",
        skillBody: "# Updated service skill\n",
      }),
      () => manageServicePackageSkillTool.execute(toolCtx, { action: "install" }),
    );
    expect(reinstalled.ok).toBe(true);
    if (reinstalled.ok) {
      expect(reinstalled.data).toMatchObject({
        skill_id: skillId,
        skill_version: 4,
        state: "draft_review_required",
      });
    }
  });

  test("refuses package-skill updates after local edits", async () => {
    const principal = {
      ...makeTestPrincipal({
        tenant_id,
        id: "00000000-0000-4000-8000-000000000044",
        roles: ["admin"],
      }),
      auth_source: { kind: "browser_session" as const, session_id: nextUuid() },
    };
    const toolCtx = makeCtx(package_connector, undefined, principal);
    const localEditPackage = {
      packageId: "com.example.local-edit-skill",
      packageName: "Example Local Edit Service",
    };
    const installed = await withSelfHostedDriverFetchForTests(packageFetch(localEditPackage), () =>
      manageServicePackageSkillTool.execute(toolCtx, { action: "install" }),
    );
    if (!installed.ok) throw new Error(JSON.stringify(installed));
    const skillId = (installed.data as { skill_id: string }).skill_id;
    await updateSkill(
      tenant_id,
      skillId,
      { expected_version: 1, title: "Local guide", body: "Local edit\n" },
      principal.id,
      ctx.db,
      "user",
    );

    const result = await withSelfHostedDriverFetchForTests(
      packageFetch({
        ...localEditPackage,
        packageVersion: "2.1.0",
        skillBody: "# Updated service skill\n",
      }),
      () =>
        manageServicePackageSkillTool.execute(toolCtx, {
          action: "update",
          skill_id: skillId,
          expected_version: 2,
        }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("locally edited package skill was overwritten");
    expect(result.error_code).toBe("service_package_skill_local_changes");
    expect(await getSkill(tenant_id, skillId, ctx.db)).toMatchObject({
      title: "Local guide",
      body: "Local edit\n",
      version: 2,
    });
  });

  test("preserves local skill tags through package update and reinstall", async () => {
    const principal = {
      ...makeTestPrincipal({
        tenant_id,
        id: "00000000-0000-4000-8000-000000000045",
        roles: ["admin"],
      }),
      auth_source: { kind: "browser_session" as const, session_id: nextUuid() },
    };
    const toolCtx = makeCtx(package_connector, undefined, principal);
    const packageInfo = {
      packageId: "com.example.preserved-tags",
      packageName: "Example Tag Service",
    };
    const installed = await withSelfHostedDriverFetchForTests(packageFetch(packageInfo), () =>
      manageServicePackageSkillTool.execute(toolCtx, { action: "install" }),
    );
    if (!installed.ok) throw new Error(JSON.stringify(installed));
    const skillId = (installed.data as { skill_id: string }).skill_id;
    const skill = await getSkill(tenant_id, skillId, ctx.db);
    if (!skill) throw new Error("installed package skill was not persisted");
    await updateSkill(
      tenant_id,
      skillId,
      { expected_version: 1, tags: [...skill.tags, "local:keep"] },
      principal.id,
      ctx.db,
      "user",
    );

    const updated = await withSelfHostedDriverFetchForTests(
      packageFetch({ ...packageInfo, packageVersion: "2.1.0", skillBody: "Updated guide\n" }),
      () =>
        manageServicePackageSkillTool.execute(toolCtx, {
          action: "update",
          skill_id: skillId,
          expected_version: 2,
        }),
    );
    expect(updated.ok).toBe(true);
    expect(await getSkill(tenant_id, skillId, ctx.db)).toMatchObject({
      status: "draft",
      version: 3,
      tags: expect.arrayContaining(["local:keep", "subkit-service-package-version:2.1.0"]),
    });

    const archived = await manageServicePackageSkillTool.execute(toolCtx, {
      action: "archive",
      skill_id: skillId,
      expected_version: 3,
    });
    expect(archived.ok).toBe(true);
    const reinstalled = await withSelfHostedDriverFetchForTests(
      packageFetch({ ...packageInfo, packageVersion: "2.1.0", skillBody: "Updated guide\n" }),
      () => manageServicePackageSkillTool.execute(toolCtx, { action: "install" }),
    );
    expect(reinstalled.ok).toBe(true);
    expect(await getSkill(tenant_id, skillId, ctx.db)).toMatchObject({
      status: "draft",
      version: 5,
      tags: expect.arrayContaining(["local:keep", "subkit-service-package-version:2.1.0"]),
    });
  });

  test("enrolls a saved service connector without returning its credential and resumes idempotently", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body: string | null }> = [];
    const principal = {
      provider: "test",
      kind: "user" as const,
      id: "user-support-enrollment",
      tenant_id,
      roles: ["admin"],
      auth_source: { kind: "browser_session" as const, session_id: nextUuid() },
    };
    const refused = await withSelfHostedDriverFetchForTests(packageFetch({ calls }), () =>
      enrollServicePackageConnectorTool.execute(
        makeCtx(package_connector, undefined, {
          provider: principal.provider,
          kind: principal.kind,
          id: principal.id,
          tenant_id,
          roles: principal.roles,
        }),
        { connector_id: package_connector },
      ),
    );
    expect(refused).toMatchObject({ ok: false, error_code: "user_confirmation_required" });
    expect(calls).toHaveLength(0);
    const run = () =>
      enrollServicePackageConnectorTool.execute(makeCtx(package_connector, undefined, principal), {
        connector_id: package_connector,
      });
    const result = await withSelfHostedDriverFetchForTests(packageFetch({ calls }), run);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("svc_");
    expect((result.data as { message: string }).message).toContain("ist eingerichtet");
    expect(calls.filter((call) => call.url.endsWith("/v1/reporters/enroll"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith("/v1/reporters/enroll/ack"))).toHaveLength(1);
    const registration = calls.find((call) => call.url.endsWith("/v1/reporters/enroll"))!;
    const registrationBody = JSON.parse(registration.body ?? "{}");
    expect(registrationBody).toMatchObject({ label: "Package Service", origin: "self_hosted" });
    expect(registration.headers.get("idempotency-key")).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    const [savedConnector] = await ctx.db
      .select({ auth_type: connectors.auth_type })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, package_connector)));
    expect(savedConnector?.auth_type).toBe("header");
    const credential = await getCredentialForConnector(tenant_id, package_connector, "dev", ctx.db);
    expect(credential?.value).toEqual({
      mode: "header",
      headers: { "X-Service-Key": `svc_${"x".repeat(40)}` },
    });

    const before = calls.filter((call) => call.url.endsWith("/v1/reporters/enroll")).length;
    const retry = await withSelfHostedDriverFetchForTests(packageFetch({ calls }), run);
    expect(retry.ok).toBe(true);
    expect(calls.filter((call) => call.url.endsWith("/v1/reporters/enroll"))).toHaveLength(before);
  });

  test("does not replace an unsaved workflow draft", async () => {
    const ctx = makeCtx(null, {
      workflow: { name: "Existing draft", slug: "my-draft", steps: [{ id: "step" }] },
    });
    const result = await prepareServicePackageWorkflowTool.execute(ctx, {
      connector_id: package_connector,
      workflow_slug: "support-preview-status",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error_code).toBe("workflow_draft_in_progress");
  });
});
