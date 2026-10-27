import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getCredentialForConnector } from "../../../credentials/service.ts";
import {
  connectorDocuments,
  connectors,
  knowledgeSources,
  tenants,
} from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { getSkill, updateSkill } from "../../../skills/service.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { withSelfHostedDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { makeTestPrincipal } from "../../../tools/tests/_helpers.ts";
import type { DraftDocument } from "../../types.ts";
import { enrollServicePackageConnectorTool } from "../enroll-service-package-connector.ts";
import { fetchConnectorSelfDescriptionTool } from "../fetch-connector-self-description.ts";
import type { ToolContext } from "../index.ts";
import { manageServicePackageSkillTool } from "../manage-service-package-skill.ts";
import { prepareServicePackageWorkflowTool } from "../prepare-service-package-workflow.ts";

let ctx: TestDb;
let tenant_id: string;
let connector_with_links: string;
let connector_without_links: string;
let package_connector: string;
const nextUuid = createDeterministicUuidFactory(0x51a7);
const FOREIGN_CONNECTOR_ID = "00000000-0000-4000-8000-000000000099";
const FOREIGN_WORKFLOW_ID = "00000000-0000-4000-8000-000000000098";

beforeAll(async () => {
  ctx = await createTestDb("fetch_connector_self_description");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-self-desc", display_name: "T" })
    .returning();
  tenant_id = t!.id;

  const [withLinks] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "acme",
      display_name: "Acme",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://api.acme.test",
      config: {},
      self_description: {
        links: [
          {
            kind: "llms_full",
            url: "https://api.acme.test/llms-full.txt",
            source: "discovery",
            discovered_at: "2026-01-01T00:00:00.000Z",
          },
          {
            kind: "openapi",
            url: "https://api.acme.test/openapi.json",
            source: "discovery",
            discovered_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    })
    .returning();
  connector_with_links = withLinks!.id;

  const [withoutLinks] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "bare",
      display_name: "Bare",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://api.bare.test",
      config: {},
    })
    .returning();
  connector_without_links = withoutLinks!.id;

  const [packageConnector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "package-service",
      display_name: "Package Service",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://api.acme.test/support",
      config: {},
    })
    .returning();
  package_connector = packageConnector!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeCtx(
  connector_id: string | null,
  initialDraft?: DraftDocument,
  principal: ToolContext["principal"] = null,
): ToolContext {
  let draft = initialDraft ?? { workflow: { name: "", steps: [] } };
  return {
    db: ctx.db,
    tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: legacy; review before changing
    actor_id: null,
    principal,
    connector_id,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
    },
  };
}

function fakeFetch(body: string): typeof fetch {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain" },
    })) as unknown as typeof fetch;
}

function packageFetch(
  options: {
    calls?: Array<{ url: string; method: string; headers: Headers; body: string | null }>;
    badSkillHash?: boolean;
    foreignSkill?: boolean;
    foreignWorkflow?: boolean;
    directWorkflowUrl?: boolean;
    missingWorkflowBinding?: boolean;
    workflowCall?: boolean;
    skillBody?: string;
    packageVersion?: string;
    packageId?: string;
    packageName?: string;
  } = {},
): typeof fetch {
  const packageId = options.packageId ?? "com.example.service";
  const packageName = options.packageName ?? "Example Service";
  const installLabel = "$" + "{installation.label}";
  const installVersion = "$" + "{installation.engine_version}";
  const skill = options.skillBody ?? "# Optional service skill\n";
  const authoring = "Review before use.\n";
  const openapi = '{"openapi":"3.1.0"}';
  const workflows = [
    {
      name: "Read status",
      slug: "support-preview-status",
      steps: [
        {
          kind: "request",
          id: "read-status",
          connector_id: options.foreignWorkflow ? FOREIGN_CONNECTOR_ID : package_connector,
          ...(options.directWorkflowUrl ? { url: "https://other.example/path" } : {}),
          method: "GET",
          path: "/v1/status",
        },
      ],
    },
    ...(options.workflowCall
      ? [
          {
            name: "Call another workflow",
            slug: "support-preview-call",
            steps: [
              {
                kind: "call",
                id: "call-other",
                workflow_id: FOREIGN_WORKFLOW_ID,
              },
            ],
          },
        ]
      : []),
  ];
  const workflowBody = JSON.stringify({
    format: "subkit.workflow-package/v1",
    package: packageId,
    version: options.packageVersion ?? "2.0.0",
    connector_id: package_connector,
    sha256: createHash("sha256").update(JSON.stringify(workflows)).digest("hex"),
    workflows,
  });
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const manifest = {
    format: "subkit.package/v1",
    id: packageId,
    version: options.packageVersion ?? "2.0.0",
    name: packageName,
    authentication: {
      type: "enrollment",
      endpoint: "v1/reporters/enroll",
      acknowledgement: "v1/reporters/enroll/ack",
      request: {
        body: {
          label: installLabel,
          origin: "self_hosted",
          engine_version: installVersion,
        },
      },
      credential: {
        header: "X-Service-Key",
        prefix: "svc_",
        responseField: "key",
        recoverableUntilAcknowledged: true,
      },
      recovery: {
        idempotencyHeader: "Idempotency-Key",
        proofHeader: "X-Recovery-Proof",
        acknowledgeAfterEncryptedStorage: true,
      },
    },
    artifacts: {
      skill: {
        href: options.foreignSkill ? "https://foreign.example/skill.md" : "skill.md",
        sha256: options.badSkillHash ? "0".repeat(64) : digest(skill),
      },
      authoring: { href: "authoring.md", sha256: digest(authoring) },
      openapi: { href: "openapi.json", sha256: digest(openapi) },
      workflows: {
        href: "package/workflows.json?connector_id={connector_id}&prefix={prefix}",
        ...(options.missingWorkflowBinding ? {} : { connectorBinding: "connector_id" }),
        prefixDefault: "service",
      },
    },
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    options.calls?.push({
      url: url.href,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    });
    let body: string | null = null;
    let status = 200;
    if (
      url.pathname.endsWith("/.well-known/oauth-authorization-server") ||
      url.pathname.endsWith("/.well-known/openid-configuration")
    )
      status = 404;
    else if (url.pathname === "/support/.well-known/service-descriptor.json")
      body = JSON.stringify({
        name: "Example Service",
        links: [{ rel: "package", href: "../package.json" }],
      });
    else if (url.pathname === "/support/package.json") body = JSON.stringify(manifest);
    else if (url.pathname === "/support/skill.md") body = skill;
    else if (url.pathname === "/support/authoring.md") body = authoring;
    else if (url.pathname === "/support/openapi.json") body = openapi;
    else if (url.pathname === "/support/v1/reporters/enroll")
      body = JSON.stringify({ key: `svc_${"x".repeat(40)}` });
    else if (url.pathname === "/support/v1/reporters/enroll/ack")
      body = JSON.stringify({
        enrollment_id: "00000000-0000-5000-8000-000000000000",
        acknowledged: true,
      });
    else if (url.pathname === "/support/package/workflows.json") {
      expect(url.searchParams.get("connector_id")).toBe(package_connector);
      expect(url.searchParams.get("prefix")).toBe("support-preview");
      body = workflowBody;
    } else if (url.hostname === "foreign.example") {
      throw new Error("foreign package artifact was fetched");
    } else status = 404;
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

async function countPersistedRows(): Promise<{ docs: number; sources: number }> {
  const docs = await ctx.db
    .select({ id: connectorDocuments.id })
    .from(connectorDocuments)
    .where(eq(connectorDocuments.tenant_id, tenant_id));
  const sources = await ctx.db
    .select({ id: knowledgeSources.id })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.tenant_id, tenant_id));
  return { docs: docs.length, sources: sources.length };
}

describe("fetch_connector_self_description", () => {
  test("returns the fetched body transiently and persists nothing", async () => {
    const before = await countPersistedRows();
    const result = await withSelfHostedDriverFetchForTests(
      fakeFetch("# Acme LLMs doc\nhello world"),
      () =>
        fetchConnectorSelfDescriptionTool.execute(makeCtx(connector_with_links), { kind: "llms" }),
    );

    expect(result.ok).toBe(true);
    const data = result.data as {
      connector_slug: string;
      documents: Array<{ kind: string; url: string; body: string; truncated: boolean }>;
    };
    expect(data.connector_slug).toBe("acme");
    expect(data.documents).toHaveLength(1);
    expect(data.documents[0]!.kind).toBe("llms");
    expect(data.documents[0]!.url).toBe("https://api.acme.test/llms-full.txt");
    expect(data.documents[0]!.body).toContain("hello world");
    expect(data.documents[0]!.truncated).toBe(false);

    const after = await countPersistedRows();
    expect(after.docs).toBe(before.docs);
    expect(after.sources).toBe(before.sources);

    const [row] = await ctx.db
      .select({ self_description: connectors.self_description })
      .from(connectors)
      .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, connector_with_links)));
    expect((row!.self_description as { links: unknown[] }).links).toHaveLength(2);
  });

  test("caps oversize bodies", async () => {
    const huge = "x".repeat(200 * 1024);
    const result = await withSelfHostedDriverFetchForTests(fakeFetch(huge), () =>
      fetchConnectorSelfDescriptionTool.execute(makeCtx(connector_with_links), { kind: "llms" }),
    );
    expect(result.ok).toBe(true);
    const data = result.data as {
      documents: Array<{ body: string; truncated: boolean }>;
    };
    expect(data.documents[0]!.truncated).toBe(true);
    expect(Buffer.byteLength(data.documents[0]!.body, "utf8")).toBeLessThanOrEqual(50 * 1024);
  });

  test("returns the no-link-recorded path when self_description is empty", async () => {
    const result = await withSelfHostedDriverFetchForTests(fakeFetch("never called"), () =>
      fetchConnectorSelfDescriptionTool.execute(makeCtx(connector_without_links), { kind: "all" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error_code).toBe("no_self_description_link");
    expect(result.message).toContain("discover_connector_endpoints");
    expect(result.next_best_actions).toContain("discover_connector_endpoints");
  });

  test("returns no-connector-in-scope when none is bound", async () => {
    const result = await fetchConnectorSelfDescriptionTool.execute(makeCtx(null), { kind: "all" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error_code).toBe("no_connector_in_scope");
  });

  test("previews verified package artifacts for the connector without installing them", async () => {
    const before = await countPersistedRows();
    const result = await withSelfHostedDriverFetchForTests(packageFetch(), () =>
      fetchConnectorSelfDescriptionTool.execute(makeCtx(package_connector), {
        kind: "package",
        prefix: "support-preview",
      }),
    );
    expect(result.ok).toBe(true);
    const data = result.data as {
      package: { id: string; version: string };
      artifacts: Array<{ name: string; verified: boolean; body: string }>;
      review_required: boolean;
      install_state: string;
    };
    expect(data.package).toMatchObject({
      id: "com.example.service",
      version: "2.0.0",
    });
    expect(data.artifacts.map((artifact) => artifact.name).sort()).toEqual([
      "authoring",
      "openapi",
      "skill",
      "workflows",
    ]);
    expect(data.artifacts.every((artifact) => artifact.verified)).toBe(true);
    expect(data.artifacts.find((artifact) => artifact.name === "workflows")?.body).toContain(
      "support-preview-status",
    );
    expect(data.review_required).toBe(true);
    expect(data.install_state).toBe("preview_only");
    expect(await countPersistedRows()).toEqual(before);
  });

  test("refuses foreign package artifacts and checksum mismatches", async () => {
    const result = await withSelfHostedDriverFetchForTests(
      packageFetch({ badSkillHash: true, foreignSkill: true }),
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
    expect(data.artifacts.map((artifact) => artifact.name)).not.toContain("skill");
    expect(data.errors.map((error) => error.name)).toContain("skill");
  });

  test("refuses workflow artifacts bound to a different connector", async () => {
    const result = await withSelfHostedDriverFetchForTests(
      packageFetch({ foreignWorkflow: true }),
      () =>
        fetchConnectorSelfDescriptionTool.execute(makeCtx(package_connector), {
          kind: "package",
          prefix: "support-preview",
        }),
    );
    expect(result.ok).toBe(true);
    const data = result.data as {
      artifacts: Array<{ name: string }>;
      errors: Array<{ name: string; error: string }>;
    };
    expect(data.artifacts.map((artifact) => artifact.name)).not.toContain("workflows");
    expect(data.errors.find((error) => error.name === "workflows")?.error).toContain(
      "unbound or foreign connector",
    );
  });

  test("refuses direct URLs and missing connector binding declarations in workflow packages", async () => {
    for (const options of [{ directWorkflowUrl: true }, { missingWorkflowBinding: true }]) {
      const result = await withSelfHostedDriverFetchForTests(packageFetch(options), () =>
        fetchConnectorSelfDescriptionTool.execute(makeCtx(package_connector), {
          kind: "package",
          prefix: "support-preview",
        }),
      );
      expect(result.ok).toBe(true);
      const data = result.data as {
        artifacts: Array<{ name: string }>;
        errors: Array<{ name: string; error: string }>;
      };
      expect(data.artifacts.map((artifact) => artifact.name)).not.toContain("workflows");
      expect(data.errors.some((error) => error.name === "workflows")).toBe(true);
    }
  });

  test("refuses package workflows that invoke another workflow", async () => {
    const result = await withSelfHostedDriverFetchForTests(
      packageFetch({ workflowCall: true }),
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

  test("explains a pending package setup in plain German", async () => {
    const toolCtx = makeCtx(package_connector);
    toolCtx.locale = "de";
    toolCtx.workflow_id = nextUuid();

    const result = await prepareServicePackageWorkflowTool.execute(toolCtx, {
      workflow_slug: "support-preview-status",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the current draft to block package setup");
    expect(result.message).toBe(
      "Schließe zuerst die aktuelle Einrichtung ab. Danach kann ich den nächsten Teil vorbereiten.",
    );
    expect(result.message).not.toContain("workflow");
    expect(result.message).not.toContain("Paket");
  });

  test("hides package slugs from user-facing missing-workflow messages", async () => {
    const toolCtx = makeCtx(package_connector);
    toolCtx.locale = "de";

    const result = await withSelfHostedDriverFetchForTests(packageFetch(), () =>
      prepareServicePackageWorkflowTool.execute(toolCtx, {
        workflow_slug: "not-published",
        prefix: "support-preview",
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the missing package workflow to be rejected");
    expect(result.message).toBe("Diesen Teil der Einrichtung konnte ich beim Dienst nicht finden.");
    expect(result.message).not.toContain("not-published");
  });

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
    expect(data.workflow).toEqual({
      slug: "support-preview-status",
      name: "Read status",
      step_count: 1,
    });
    expect(data.install_state).toBe("inactive_draft");
    expect(data.review_required).toBe(true);
    expect(ctx.getDraft().workflow.slug).toBe("support-preview-status");
    expect(ctx.getDraft().workflow.steps[0]?.connector_id).toBe(package_connector);
  });

  test("installs a package skill as a connector-scoped draft and is idempotent", async () => {
    const principal = {
      ...makeTestPrincipal({ tenant_id, id: "00000000-0000-4000-8000-000000000042" }),
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
      ...makeTestPrincipal({ tenant_id, id: "00000000-0000-4000-8000-000000000043" }),
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
      ...makeTestPrincipal({ tenant_id, id: "00000000-0000-4000-8000-000000000044" }),
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
      ...makeTestPrincipal({ tenant_id, id: "00000000-0000-4000-8000-000000000045" }),
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
    };
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
