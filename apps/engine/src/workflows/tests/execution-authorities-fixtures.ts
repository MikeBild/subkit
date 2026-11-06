import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { sessions, tenants, users, workflows, workflowVersions } from "../../db/schema/index.ts";
import type { TestDb } from "../../db/tests/setup.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { previewWorkflowAuthority } from "../execution-authorities.ts";

export function executionAuthoritiesFixtures(state: { readonly ctx: TestDb }) {
  let counter = 0;

  async function fixture(extraDefinition: Record<string, unknown> = {}) {
    const slug = `authority-grant-${++counter}`;
    const [tenant] = await state.ctx.db
      .insert(tenants)
      .values({ slug, display_name: slug })
      .returning();
    if (!tenant) throw new Error("missing tenant fixture");
    const [user] = await state.ctx.db
      .insert(users)
      .values({
        tenant_id: tenant.id,
        email: `${slug}@example.test`,
        role_id: await builtinRoleId(state.ctx.db, "admin"),
      })
      .returning();
    const [workflow] = await state.ctx.db
      .insert(workflows)
      .values({ tenant_id: tenant.id, slug, name: slug, lifecycle: "draft" })
      .returning();
    if (!user || !workflow) throw new Error("missing workflow fixture");
    const [version] = await state.ctx.db
      .insert(workflowVersions)
      .values({
        tenant_id: tenant.id,
        workflow_id: workflow.id,
        version: 1,
        dag: {
          ...extraDefinition,
          name: slug,
          steps: [
            {
              id: "send",
              kind: "request",
              method: "POST",
              url: "https://example.test/messages",
              body: { recipient: "reviewed@example.test" },
            },
          ],
        },
      })
      .returning();
    const from = await databaseNow(state.ctx.db);
    const until = new Date(from.getTime() + 60 * 60_000);
    const [session] = await state.ctx.db
      .insert(sessions)
      .values({
        tenant_id: tenant.id,
        user_id: user.id,
        expires_at: until,
        absolute_expires_at: until,
      })
      .returning();
    if (!version || !session) throw new Error("missing session fixture");
    const payload = { tenant_id: tenant.id, user_id: user.id, session_id: session.id };
    const principal: ResolvedPrincipal = {
      provider: "session",
      kind: "user",
      id: user.id,
      tenant_id: tenant.id,
      roles: ["admin"],
      session_id: session.id,
    };
    const request = new Request("https://example.test/v1/workflows/authority", {
      method: "POST",
      headers: {
        cookie: browserSessionCookie(await signBrowserSession(payload)),
        "x-subkit-csrf": await signBrowserCsrf(payload),
      },
    });
    const preview = await previewWorkflowAuthority(
      {
        tenant_id: tenant.id,
        workflow_id: workflow.id,
        workflow_version_id: version.id,
        execution_environment: "dev",
      },
      state.ctx.db,
    );
    const input = {
      workflow_version_id: version.id,
      expected_manifest_digest: preview.digest,
      execution_environment: "dev" as const,
      valid_from: from.toISOString(),
      valid_until: until.toISOString(),
      max_runs: 3,
    };
    return { input, context: { db: state.ctx.db, request, principal }, workflow, session, version };
  }

  return { fixture };
}
