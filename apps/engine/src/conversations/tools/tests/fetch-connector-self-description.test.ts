import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { connectorDocuments, connectors, knowledgeSources } from "../../../db/schema/index.ts";
import { withSelfHostedDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { fetchConnectorSelfDescriptionTool } from "../fetch-connector-self-description.ts";
import { prepareServicePackageWorkflowTool } from "../prepare-service-package-workflow.ts";
import {
  connector_with_links,
  connector_without_links,
  ctx,
  makeCtx,
  nextUuid,
  package_connector,
  packageFetch,
  tenant_id,
  useFetchConnectorSelfDescriptionSetup,
} from "./fetch-connector-self-description-fixtures.ts";

useFetchConnectorSelfDescriptionSetup();

function fakeFetch(body: string): typeof fetch {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain" },
    })) as unknown as typeof fetch;
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
      artifacts: Array<{ name: string; checksum_matched: boolean; body: string }>;
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
    expect(data.artifacts.every((artifact) => artifact.checksum_matched)).toBe(true);
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

  test("explains a conversation bound to its saved setup in plain German", async () => {
    const toolCtx = makeCtx(package_connector);
    toolCtx.locale = "de";
    toolCtx.workflow_id = nextUuid();

    const result = await prepareServicePackageWorkflowTool.execute(toolCtx, {
      workflow_slug: "support-preview-status",
      prefix: "support-preview",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the current draft to block package setup");
    expect(result.error_code).toBe("conversation_bound_to_workflow");
    expect(result.message).toBe(
      "Diese Unterhaltung gehört zu der Einrichtung, die sie bereits gespeichert hat. Starte für den nächsten Teil eine neue Unterhaltung.",
    );
    expect(result.message?.toLowerCase()).not.toContain("workflow");
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
});
