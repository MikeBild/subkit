import { afterAll, beforeAll, expect } from "bun:test";
import { createHash } from "node:crypto";
import { connectors, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import type { DraftDocument } from "../../types.ts";
import type { ToolContext } from "../index.ts";

export let ctx: TestDb;
export let tenant_id: string;
export let connector_with_links: string;
export let connector_without_links: string;
export let package_connector: string;
export const nextUuid = createDeterministicUuidFactory(0x51a7);
export const FOREIGN_CONNECTOR_ID = "00000000-0000-4000-8000-000000000099";
export const FOREIGN_WORKFLOW_ID = "00000000-0000-4000-8000-000000000098";

export function makeCtx(
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

export function packageFetch(
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
    workflowSlug?: string;
    workflowPath?: string;
    prefixDefault?: string;
    expectedPrefix?: string;
    callerBound?: boolean;
    workflowsManifestHash?: string;
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
      slug: options.workflowSlug ?? "support-preview-status",
      ...(options.callerBound
        ? { required_caller_kind: "user", tool_effect: "read", timeout_ms: 30_000 }
        : {}),
      steps: [
        {
          kind: "request",
          id: "read-status",
          connector_id: options.foreignWorkflow ? FOREIGN_CONNECTOR_ID : package_connector,
          ...(options.directWorkflowUrl ? { url: "https://other.example/path" } : {}),
          method: "GET",
          path: options.workflowPath ?? "/v1/status",
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
        ...(options.workflowsManifestHash ? { sha256: options.workflowsManifestHash } : {}),
        prefixDefault: options.prefixDefault ?? "service",
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
      expect(url.searchParams.get("prefix")).toBe(options.expectedPrefix ?? "support-preview");
      body = workflowBody;
    } else if (url.hostname === "foreign.example") {
      throw new Error("foreign package artifact was fetched");
    } else status = 404;
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

export function useFetchConnectorSelfDescriptionSetup(): void {
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
}
