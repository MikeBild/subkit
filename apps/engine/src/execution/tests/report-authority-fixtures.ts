import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { connectors, sessions, users, workflowsSchedules } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import {
  grantWorkflowAuthority,
  previewWorkflowAuthority,
} from "../../workflows/execution-authorities.ts";
import { prepareReportAuthority } from "../../workflows/prepare-report-authority.ts";
import { GMAIL_SEND_TARGET } from "../../workflows/report-delivery-boundary.ts";
import { admitAuthorizedWorkflowExecution } from "../authority-admission.ts";
import { callerFromPrincipal } from "../caller-context.ts";
import { runExecution } from "../engine.ts";
import { createWorkflowRow, type EngineTestCtx } from "./setup.ts";

export function reportAuthorityFixtures(state: { readonly ctx: EngineTestCtx }) {
  let sequence = 0;

  async function fixture(withRead: boolean | "path" | "analytics" | "analytics-tenant" = false) {
    const analytics = withRead === "analytics" || withRead === "analytics-tenant";
    const [analyticsConnector] =
      withRead === "analytics-tenant"
        ? await state.ctx.testDb.db
            .insert(connectors)
            .values({
              tenant_id: state.ctx.tenantId,
              slug: `analytics-${sequence + 1}`,
              display_name: "Analytics",
              driver: "http",
              auth_type: "none",
              environment: "dev",
              base_url: "https://analyticsdata.googleapis.com",
              template_slug: "google-analytics",
              template_source: "tenant" as const,
            })
            .returning()
        : [];
    const raw = Buffer.from(
      "From: sender@example.test\r\nTo: recipient@example.test\r\nSubject: Report\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\nReport",
    ).toString("base64url");
    const wf = await createWorkflowRow(state.ctx, {
      name: "Daily report",
      slug: `report-${++sequence}`,
      steps: [
        ...(withRead
          ? [
              {
                id: "read",
                kind: "request" as const,
                method: analytics ? ("POST" as const) : ("GET" as const),
                ...(analyticsConnector ? { connector_id: analyticsConnector.id } : {}),
                body: analytics
                  ? {
                      dateRanges: [{ startDate: "yesterday", endDate: "yesterday" }],
                      metrics: [{ name: "activeUsers" }],
                    }
                  : undefined,
                url: analytics
                  ? "https://analyticsdata.googleapis.com/v1beta/properties/123:runReport"
                  : withRead === "path"
                    ? "https://metrics.example.test/v2/projects/${input.window}/resources"
                    : "https://metrics.example.test/history",
                query:
                  withRead === "path" || analytics
                    ? undefined
                    : {
                        host_id: "fixed-resource",
                        end: "${input.window}",
                      },
                max_retries: 0,
              },
            ]
          : []),
        {
          id: "send",
          kind: "request",
          method: "POST",
          url: GMAIL_SEND_TARGET,
          body: { raw: "${input.raw}" },
          max_retries: 0,
        },
      ],
    });
    const db = state.ctx.testDb.db;
    const now = await databaseNow(db);
    const [user] = await db
      .insert(users)
      .values({
        tenant_id: state.ctx.tenantId,
        email: `human-${sequence}@example.test`,
        role_id: await builtinRoleId(db, "admin"),
      })
      .returning();
    if (!user) throw new Error("missing user");
    const [session] = await db
      .insert(sessions)
      .values({
        tenant_id: state.ctx.tenantId,
        user_id: user.id,
        expires_at: new Date(now.getTime() + 3600000),
      })
      .returning();
    if (!session) throw new Error("missing session");
    const identity = { tenant_id: state.ctx.tenantId, user_id: user.id, session_id: session.id };
    const principal: ResolvedPrincipal = {
      provider: "session",
      kind: "user",
      id: user.id,
      tenant_id: state.ctx.tenantId,
      roles: ["admin"],
      session_id: session.id,
    };
    const request = new Request("https://example.test/grant", {
      method: "POST",
      headers: {
        cookie: browserSessionCookie(await signBrowserSession(identity)),
        "x-subkit-csrf": await signBrowserCsrf(identity),
      },
    });
    const [schedule] = await db
      .insert(workflowsSchedules)
      .values({
        tenant_id: state.ctx.tenantId,
        workflow_id: wf.workflow_id,
        cron: "0 7 * * *",
        execution_mode: "dev",
        input: { raw, window: raw.length },
        admission_hold: {
          reason_code: "execution_authority_unavailable",
          observed_at: now.toISOString(),
        },
      })
      .returning();
    if (!schedule) throw new Error("missing schedule");
    const inspect = () =>
      previewWorkflowAuthority(
        {
          tenant_id: state.ctx.tenantId,
          workflow_id: wf.workflow_id,
          workflow_version_id: wf.version_id,
          execution_environment: "dev",
        },
        db,
      );
    const prepare = async (value = raw) =>
      runExecution({
        tenant_id: state.ctx.tenantId,
        db,
        source: { kind: "saved", workflow_id: wf.workflow_id },
        input: { raw: value, window: value.length },
        options: { hold_writes: true, execution_mode: "dev", principal },
      });
    const grant = async () => {
      const preview = await inspect();
      return grantWorkflowAuthority(
        wf.workflow_id,
        {
          workflow_version_id: wf.version_id,
          expected_manifest_digest: preview.digest,
          execution_environment: "dev",
          valid_from: now.toISOString(),
          valid_until: new Date(now.getTime() + 3600000).toISOString(),
          max_runs: 2,
        },
        { db, request, principal },
      );
    };
    const run = async (value = raw, resource: string | number = value.length) => {
      const admitted = await admitAuthorizedWorkflowExecution(
        {
          tenant_id: state.ctx.tenantId,
          workflow_id: wf.workflow_id,
          execution_environment: "dev",
          request_source: "scheduler",
          input: { raw: value, window: resource },
        },
        db,
        callerFromPrincipal(principal, state.ctx.tenantId),
      );
      return runExecution({
        tenant_id: state.ctx.tenantId,
        db,
        source: { kind: "saved", workflow_id: wf.workflow_id },
        input: { raw: value, window: resource },
        options: { existing_execution_id: admitted.execution_id, principal },
      });
    };
    const automaticPrepare = () =>
      prepareReportAuthority(
        {
          tenant_id: state.ctx.tenantId,
          workflow_id: wf.workflow_id,
          workflow_version_id: wf.version_id,
          execution_environment: "dev",
        },
        db,
        principal,
      );
    return {
      raw,
      wf,
      schedule,
      inspect,
      prepare,
      automaticPrepare,
      grant,
      run,
      principal,
      request,
      now,
    };
  }

  return { fixture };
}
