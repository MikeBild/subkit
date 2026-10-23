import {
  createEmptyDraftDocument,
  withWorkflowDraft,
} from "../../src/conversations/authoring-state.ts";
import { fetchConnectorDocsTool } from "../../src/conversations/tools/fetch-connector-docs.ts";
import { connectors } from "../../src/db/schema/index.ts";
import { ingestDocs } from "../../src/docs-ingestion/service.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withAuthoringEvalEnv } from "./shared/authoring-env.ts";

interface Input {
  query: string;
  connectors: Array<{ slug: string; display_name: string; base_url: string; docs: string }>;
  expect: { scope_error_code: string };
}

interface DocsData {
  hits?: Array<{ connector_slug?: string }>;
  connectors_searched?: string[];
  error_code?: string;
  resolvable_connectors?: string[];
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  return withAuthoringEvalEnv("docs_scope", async (env) => {
    const c = new Checks();
    const seeded: Array<{ id: string; slug: string }> = [];
    for (const connector of input.connectors) {
      const [row] = await env.db
        .insert(connectors)
        .values({
          tenant_id: env.tenant_id,
          slug: connector.slug,
          display_name: connector.display_name,
          driver: "http",
          base_url: connector.base_url,
          auth_type: "none",
        })
        .returning({ id: connectors.id });
      if (!row) return { pass: false, reason: `connector ${connector.slug} seed failed` };
      await ingestDocs(
        {
          tenant_id: env.tenant_id,
          connector_id: row.id,
          input: { source_type: "markdown", content: connector.docs },
        },
        env.db,
      );
      seeded.push({ id: row.id, slug: connector.slug });
    }
    const slugs = seeded.map((connector) => connector.slug).sort();

    const empty = createEmptyDraftDocument("workflow_authoring");
    const draft = withWorkflowDraft(empty, {
      ...empty.workflow,
      name: "Invoice reminders",
      slug: "invoice-reminders",
      steps: seeded.map((connector, index) => ({
        id: `step_${index}`,
        kind: "request",
        method: index === 0 ? "GET" : "POST",
        connector_id: connector.id,
        path: index === 0 ? "/invoices" : "/messages",
      })),
    });

    const scoped = await fetchConnectorDocsTool.execute(env.makeToolCtx(draft), {
      query: input.query,
    });
    const scopedData = (scoped.data ?? {}) as DocsData;
    c.check(scoped.ok, `draft-scoped docs lookup failed: ${JSON.stringify(scoped.data)}`);
    c.check(
      JSON.stringify([...(scopedData.connectors_searched ?? [])].sort()) === JSON.stringify(slugs),
      `connectors_searched ${JSON.stringify(scopedData.connectors_searched)} != ${JSON.stringify(slugs)}`,
    );
    const hitSlugs = [...new Set((scopedData.hits ?? []).map((hit) => hit.connector_slug ?? ""))];
    c.check(
      JSON.stringify(hitSlugs.sort()) === JSON.stringify(slugs),
      `hits name ${JSON.stringify(hitSlugs)}, expected one or more from each of ${JSON.stringify(slugs)}`,
    );

    const narrowSlug = seeded[0]?.slug ?? "";
    const narrowed = await fetchConnectorDocsTool.execute(env.makeToolCtx(draft), {
      query: input.query,
      connector: narrowSlug,
    });
    const narrowData = (narrowed.data ?? {}) as DocsData;
    c.check(narrowed.ok, `explicit connector lookup failed: ${JSON.stringify(narrowed.data)}`);
    c.check(
      JSON.stringify(narrowData.connectors_searched) === JSON.stringify([narrowSlug]),
      `explicit connector searched ${JSON.stringify(narrowData.connectors_searched)}`,
    );
    c.check(
      (narrowData.hits ?? []).every((hit) => hit.connector_slug === narrowSlug),
      "explicit connector lookup returned hits of another connector",
    );

    const unscoped = await fetchConnectorDocsTool.execute(env.makeToolCtx(), {
      query: input.query,
    });
    const unscopedData = (unscoped.data ?? {}) as DocsData;
    c.check(!unscoped.ok, "an empty draft searched docs without a connector in scope");
    c.check(
      unscopedData.error_code === input.expect.scope_error_code,
      `unscoped error_code ${unscopedData.error_code} != ${input.expect.scope_error_code}`,
    );
    c.check(
      slugs.every((slug) => (unscopedData.resolvable_connectors ?? []).includes(slug)),
      `resolvable_connectors ${JSON.stringify(unscopedData.resolvable_connectors)} misses a seeded slug`,
    );
    if (c.failed) return { pass: false, reason: c.failed };
    return { pass: true, metrics: { hits: scopedData.hits?.length ?? 0 } };
  });
}
