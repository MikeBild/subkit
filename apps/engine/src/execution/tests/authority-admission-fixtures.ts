import { and, eq } from "drizzle-orm";
import { secretNames } from "../../credentials/connections/service.ts";
import { upsertCredential } from "../../credentials/service.ts";
import {
  connectors,
  credentials,
  outboundConnections,
  tenants,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import type { TestDb } from "../../db/tests/setup.ts";
import { createSecretVersion } from "../../runtime-config/service.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";

export const actor = "00000000-0000-4000-8000-000000000001";

export function authorityAdmissionFixtures(state: { readonly ctx: TestDb }) {
  let counter = 0;

  async function fixture(
    max_runs: number | null = 2,
    input_schema?: object,
    valid_until?: Date | null,
    request?: { base_url: string; driver: "http" | "graphql"; credential?: boolean | "connection" },
  ) {
    const slug = `authority-admission-${++counter}`;
    const [tenant] = await state.ctx.db
      .insert(tenants)
      .values({ slug, display_name: slug })
      .returning();
    if (!tenant) throw new Error("missing tenant fixture");
    const [connector] = await state.ctx.db
      .insert(connectors)
      .values({
        tenant_id: tenant.id,
        slug,
        display_name: slug,
        driver: request?.driver ?? "http",
        auth_type:
          request?.credential === "connection" ? "oauth2" : request?.credential ? "bearer" : "none",
        environment: "dev",
        base_url: request?.base_url ?? "https://example.test/api",
      })
      .returning();
    const [workflow] = await state.ctx.db
      .insert(workflows)
      .values({ tenant_id: tenant.id, slug, name: slug, lifecycle: "active" })
      .returning();
    if (!workflow || !connector) throw new Error("missing workflow fixture");
    if (request?.credential)
      await upsertCredential(
        {
          tenant_id: tenant.id,
          connector_id: connector.id,
          environment: "dev",
          mode: request.credential === "connection" ? "oauth2" : "bearer",
          actor_id: null,
          value:
            request.credential === "connection"
              ? { mode: "oauth2", access_token: "connection-placeholder", token_type: "Bearer" }
              : { mode: "bearer", token: "approved-fixture-token" },
        },
        state.ctx.db,
      );
    let connection: typeof outboundConnections.$inferSelect | null = null;
    if (request?.credential === "connection") {
      const secret = await createSecretVersion(state.ctx.db, {
        name: secretNames(tenant.id, slug).access,
        value: "approved-connection-token",
        created_by: null,
      });
      const [row] = await state.ctx.db
        .insert(outboundConnections)
        .values({
          tenant_id: tenant.id,
          name: slug,
          base_url: request.base_url,
          issuer: request.base_url,
          authorization_endpoint: `${request.base_url}/authorize`,
          token_endpoint: `${request.base_url}/token`,
          client_id: "fixture-client",
          scopes: ["read", "write"],
          granted_scopes: ["read", "write"],
          access_token_version: secret.version,
        })
        .returning();
      if (!row) throw new Error("missing connection fixture");
      connection = row;
      await state.ctx.db
        .update(credentials)
        .set({ connection_id: row.id })
        .where(
          and(eq(credentials.tenant_id, tenant.id), eq(credentials.connector_id, connector.id)),
        );
    }
    const [version] = await state.ctx.db
      .insert(workflowVersions)
      .values({
        tenant_id: tenant.id,
        workflow_id: workflow.id,
        version: 1,
        dag: {
          name: slug,
          ...(input_schema ? { input_schema } : {}),
          steps: [
            {
              id: "send",
              kind: "request",
              connector_id: connector.id,
              method: "POST",
              path: "/messages",
              body: { recipient: "reviewed@example.test" },
              ...(request?.driver === "graphql"
                ? {
                    graphql: { operation: "mutation", query: "mutation { sendReport { id } }" },
                  }
                : {}),
            },
          ],
        },
      })
      .returning();
    if (!version) throw new Error("missing version fixture");
    await state.ctx.db
      .update(workflows)
      .set({ current_version_id: version.id })
      .where(eq(workflows.id, workflow.id));
    const preview = await previewWorkflowAuthority(
      {
        tenant_id: tenant.id,
        workflow_id: workflow.id,
        workflow_version_id: version.id,
        execution_environment: "dev",
      },
      state.ctx.db,
    );
    const now = await databaseNow(state.ctx.db);
    const [authority] = await state.ctx.db
      .insert(workflowExecutionAuthorities)
      .values({
        tenant_id: tenant.id,
        workflow_id: workflow.id,
        workflow_version_id: version.id,
        effect_manifest_digest: preview.digest,
        effect_manifest: { ...preview.manifest },
        target_constraints: {
          targets: preview.manifest.effects.flatMap((effect) =>
            effect.target ? [effect.target] : [],
          ),
        },
        execution_environment: "dev",
        valid_from: new Date(now.getTime() - 60_000),
        valid_until:
          valid_until === undefined ? new Date(now.getTime() + 60 * 60_000) : valid_until,
        max_runs,
        created_by: actor,
      })
      .returning();
    if (!authority) throw new Error("missing authority fixture");
    return {
      authority,
      connector,
      connection,
      version,
      workflow,
      params: {
        tenant_id: tenant.id,
        workflow_id: workflow.id,
        execution_environment: "dev" as const,
        request_source: "api" as const,
        input: { message: "approved input" },
      },
    };
  }

  async function reservations(id: string) {
    const [row] = await state.ctx.db
      .select()
      .from(workflowExecutionAuthorities)
      .where(eq(workflowExecutionAuthorities.id, id));
    return row?.reserved_runs;
  }

  return { fixture, reservations };
}
