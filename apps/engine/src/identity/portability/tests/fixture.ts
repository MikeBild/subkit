import { and, eq } from "drizzle-orm";
import { PLATFORM_CATEGORY } from "../../../api/catalog-metadata.ts";
import { createConnector, createTenantConnectorTemplate } from "../../../connectors/index.ts";
import type { Db } from "../../../db/client.ts";
import { connectors, tenants, users } from "../../../db/schema/index.ts";
import { linkStoredFile } from "../../../files/links.ts";
import { persistInlineUpload } from "../../../files/persist-inline-upload.ts";
import { createKnowledgeSource } from "../../../knowledge/index.ts";
import { createScheduleLocked } from "../../../scheduler/index.ts";
import { createSkill } from "../../../skills/index.ts";
import type { JourneyCtx } from "../../../tests/journeys/setup.ts";
import { createWorkflow } from "../../../workflows/service.ts";

export const SECRETS = {
  template_client_secret: "tpl-client-secret-4d1f9a",
  template_header: "tpl-header-secret-7c2e0b",
  template_query: "tpl-query-secret-2a8f61",
  connector_header: "conn-header-secret-91aa3c",
  connector_userinfo: "conn-userinfo-secret-5be81d",
  connector_query: "conn-query-secret-0f6d27",
  dsn_password: "dsn-password-secret-c3a9e4",
} as const;

export const MASK_TEXT = "***redacted";

export interface SourceFixture {
  ids: string[];
  connector_id: string;
  child_workflow_id: string;
  parent_workflow_id: string;
  manual_skill_id: string;
  knowledge_id: string;
  linked_file_sha: string;
  run_file_sha: string;
  seed_knowledge_slug: string;
  knowledge_body: string;
}

export async function seedTenant(
  ctx: JourneyCtx,
  slug: string,
): Promise<{ tenant_id: string; user_id: string }> {
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug, display_name: `Package ${slug}` })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  const [user] = await ctx.db
    .insert(users)
    .values({ tenant_id: tenant.id, email: `${slug}@test.local`, role_id: ctx.rbacRoleIds.admin })
    .returning();
  if (!user) throw new Error("seed user failed");
  return { tenant_id: tenant.id, user_id: user.id };
}

function requireId<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} missing`);
  return value;
}

export async function seedSourceTenant(
  db: Db,
  tenant_id: string,
  user_id: string,
): Promise<SourceFixture> {
  const ids: string[] = [tenant_id, user_id];
  const actor = { actor_id: user_id, actor_type: "user" as const };

  const template = await createTenantConnectorTemplate(
    {
      tenant_id,
      ...actor,
      input: {
        slug: "acme-template",
        name: "Acme Template",
        driver: "http",
        base_url: `https://api.acme.test?api_key=${SECRETS.template_query}`,
        auth_type: "oauth2",
        oauth: {
          client_id: "acme-public-client",
          client_secret: SECRETS.template_client_secret,
          token_endpoint: "https://auth.acme.test/token",
          extra_headers: { Authorization: `Bearer ${SECRETS.template_header}` },
        },
        ingestion_source: "none",
      },
    },
    db,
  );
  ids.push(template.id);

  const connector = await createConnector(
    {
      tenant_id,
      ...actor,
      input: {
        name: "Acme",
        slug: "acme",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: `https://svc:${SECRETS.connector_userinfo}@api.acme.test/v1?api_key=${SECRETS.connector_query}&format=json`,
        config: {
          static_headers: { "X-Api-Key": SECRETS.connector_header, Accept: "application/json" },
        },
      },
    },
    db,
  );
  ids.push(connector.id);

  const warehouse = await createConnector(
    {
      tenant_id,
      ...actor,
      input: {
        name: "Warehouse",
        slug: "warehouse",
        driver: "postgres",
        environment: "dev",
        auth_type: "none",
        dsn: `postgres://reader:${SECRETS.dsn_password}@db.acme.test:5432/warehouse`,
      },
    },
    db,
  );
  ids.push(warehouse.id);

  const platform = await createConnector(
    {
      tenant_id,
      ...actor,
      input: {
        name: "Platform Internal",
        slug: "platform-internal",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "https://platform.acme.test",
      },
    },
    db,
  );
  ids.push(platform.id);
  await db
    .update(connectors)
    .set({ category: PLATFORM_CATEGORY })
    .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, platform.id)));

  const child = await createWorkflow(
    {
      tenant_id,
      ...actor,
      def: {
        name: "Fetch widgets",
        slug: "fetch-widgets",
        trigger: { kind: "request" },
        steps: [
          {
            id: "widgets",
            kind: "request",
            method: "GET",
            connector_id: connector.id,
            path: "/widgets",
          },
        ],
      },
    },
    db,
  );
  const childWorkflow = requireId(child.workflow, `child workflow (${child.errors?.join("; ")})`);
  ids.push(childWorkflow.id);

  const parent = await createWorkflow(
    {
      tenant_id,
      ...actor,
      def: {
        name: "Widget report",
        slug: "widget-report",
        trigger: { kind: "request" },
        steps: [{ id: "run_child", kind: "call", workflow_id: childWorkflow.id }],
      },
    },
    db,
  );
  const parentWorkflow = requireId(
    parent.workflow,
    `parent workflow (${parent.errors?.join("; ")})`,
  );
  ids.push(parentWorkflow.id);

  const schedule = await createScheduleLocked(db, {
    tenant_id,
    workflow_id: childWorkflow.id,
    cron: "0 9 * * 1",
    timezone: "UTC",
    execution_mode: "dev",
    paused: false,
  });
  ids.push(schedule.row.id);

  const manual = await createSkill(
    {
      tenant_id,
      ...actor,
      slug: "widget-guide",
      input: {
        scope: "connector",
        connector_id: connector.id,
        title: "Widget guide",
        body: "List widgets with GET /widgets.",
        status: "active",
        source: "manual",
      },
    },
    db,
  );
  ids.push(manual.id);
  for (const source of ["template", "memory"] as const) {
    const excluded = await createSkill(
      {
        tenant_id,
        ...actor,
        slug: `excluded-${source}`,
        input: {
          scope: "global",
          title: `Excluded ${source}`,
          body: `Excluded ${source} body.`,
          status: "active",
          source,
        },
      },
      db,
    );
    ids.push(excluded.id);
  }

  const knowledge_body = "# Runbook\n\nRestart the widget queue before retrying.";
  const knowledge = await createKnowledgeSource(
    {
      tenant_id,
      input: { name: "Widget runbook", slug: "widget-runbook", tags: ["ops"] },
      upload: {
        buffer: new TextEncoder().encode(knowledge_body),
        filename: "runbook.md",
        mime: "text/markdown",
      },
      actor: { kind: "user", id: user_id },
    },
    db,
  );
  ids.push(knowledge.id);
  const seed = await createKnowledgeSource(
    {
      tenant_id,
      input: { name: "Seed handbook", slug: "seed-handbook" },
      upload: {
        buffer: new TextEncoder().encode("# Seed\n\nPlatform seed content."),
        filename: "seed.md",
        mime: "text/markdown",
      },
      actor: { kind: "user", id: user_id },
      source_type_override: "seed",
    },
    db,
  );
  ids.push(seed.id);

  const linked = await persistInlineUpload(db, {
    tenant_id,
    actor_id: user_id,
    filename: "widgets.csv",
    content_type: "text/csv",
    bytes: new TextEncoder().encode("id,name\n1,Widget\n"),
  });
  ids.push(linked.row.id);
  await linkStoredFile(
    db,
    {
      tenant_id,
      file_id: linked.row.id,
      resource_type: "skill",
      resource_id: manual.id,
      slug: "widgets",
      role: null,
    },
    { ...actor, request_source: "api", allowed_statuses: ["ready"] },
  );

  const runFile = await persistInlineUpload(db, {
    tenant_id,
    actor_id: user_id,
    filename: "run-output.json",
    content_type: "application/json",
    bytes: new TextEncoder().encode('{"run":"output"}'),
  });
  ids.push(runFile.row.id);
  await linkStoredFile(
    db,
    {
      tenant_id,
      file_id: runFile.row.id,
      resource_type: "workflow_run",
      resource_id: childWorkflow.id,
      slug: "output",
      role: null,
    },
    { ...actor, request_source: "api", allowed_statuses: ["ready"] },
  );

  return {
    ids,
    connector_id: connector.id,
    child_workflow_id: childWorkflow.id,
    parent_workflow_id: parentWorkflow.id,
    manual_skill_id: manual.id,
    knowledge_id: knowledge.id,
    linked_file_sha: requireId(linked.row.sha256, "linked file sha"),
    run_file_sha: requireId(runFile.row.sha256, "run file sha"),
    seed_knowledge_slug: "seed-handbook",
    knowledge_body,
  };
}
