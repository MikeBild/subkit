import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { and, eq, sql } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { executionSteps, sessions, users, workflows } from "../../db/schema/index.ts";
import { admitAuthorizedWorkflowExecution } from "../../execution/authority-admission.ts";
import { runExecution } from "../../execution/engine.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { withDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import {
  grantWorkflowAuthority,
  previewWorkflowAuthority,
} from "../../workflows/execution-authorities.ts";
import { GMAIL_SEND_TARGET } from "../../workflows/report-delivery-boundary.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

let ctx: JourneyCtx;
let principal: ResolvedPrincipal;
let grantRequest: Request;

const ENCODER = [
  "const subject = '[watchkit page] api.example.com — certificate expires';",
  "const html = '<p>watchkit.finding · api.example.com · ' + input.input.at + '</p>';",
  "const msg = 'From: ops@example.com\\r\\nTo: ops@example.com\\r\\nSubject: ' + subject +",
  "  '\\r\\nMIME-Version: 1.0\\r\\nContent-Type: text/html; charset=UTF-8\\r\\n\\r\\n' + html;",
  "return { raw: sk.base64UrlEncode(msg) };",
].join("\n");

function steps() {
  return [
    { kind: "transform", id: "compose", language: "javascript", expression: ENCODER },
    {
      kind: "request",
      id: "send_email",
      method: "POST",
      url: GMAIL_SEND_TARGET,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow substitution
      body: { raw: "${scope.compose.data.raw}" },
      report_delivery: {
        kind: "gmail_report",
        to: "ops@example.com",
        from: "ops@example.com",
        content_type: "text/html",
      },
      max_retries: 0,
    },
  ];
}

interface Diagnosis {
  code: string;
  reason?: string;
  subject: { step_id: string };
  evidence: { execution_id?: string };
  remedy_kind: string;
  fixer?: string;
  candidate_id?: string;
}

async function currentVersion(workflow_id: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: workflows.current_version_id })
    .from(workflows)
    .where(eq(workflows.id, workflow_id));
  if (!row?.id) throw new Error("workflow has no current version");
  return row.id;
}

async function grantAndRun(
  workflow_id: string,
  input: Record<string, unknown> = { at: "2026-01-01T00:00:00Z" },
) {
  const version_id = await currentVersion(workflow_id);
  const review = await previewWorkflowAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id,
      workflow_version_id: version_id,
      execution_environment: "dev",
    },
    ctx.db,
  );
  expect(review.eligible_for_repeated_runs).toBe(true);
  const now = await databaseNow(ctx.db);
  await grantWorkflowAuthority(
    workflow_id,
    {
      workflow_version_id: version_id,
      expected_manifest_digest: review.digest,
      execution_environment: "dev",
      valid_from: now.toISOString(),
      valid_until: new Date(now.getTime() + 3_600_000).toISOString(),
      max_runs: 1,
    },
    { db: ctx.db, request: grantRequest, principal },
  );
  let sends = 0;
  const remote = Object.assign(
    async () => {
      sends += 1;
      return Response.json({ id: "sent" });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  return withDriverFetchForTests(remote, async () => {
    const admitted = await admitAuthorizedWorkflowExecution(
      {
        tenant_id: ctx.tenantId,
        workflow_id,
        execution_environment: "dev",
        request_source: "scheduler",
        input,
      },
      ctx.db,
    );
    const result = await runExecution({
      tenant_id: ctx.tenantId,
      db: ctx.db,
      source: { kind: "saved", workflow_id },
      input,
      options: { existing_execution_id: admitted.execution_id, principal },
    });
    return { result, sends };
  });
}

async function diagnosis(workflow_id: string): Promise<Diagnosis[]> {
  const res = await journeyFetch(ctx, `/v1/workflows/${workflow_id}/diagnosis?environment=dev`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { diagnoses: Diagnosis[] }).diagnoses;
}

async function connect(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ctx.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${ctx.apiKey}` } },
  });
  const client = new Client({ name: "subkit-journey", version: "0.0.0" });
  await client.connect(transport as unknown as Transport);
  return client;
}

function toolData(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured && typeof structured === "object") return structured as Record<string, unknown>;
  const text = (result as { content?: Array<{ type: string; text?: string }> }).content?.find(
    (part) => part.type === "text",
  )?.text;
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

beforeAll(async () => {
  ctx = await createJourneyCtx("gate-repair-watchkit");
  const now = await databaseNow(ctx.db);
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "approver@example.com",
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
    .returning();
  if (!user) throw new Error("missing user");
  const [session] = await ctx.db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: user.id,
      expires_at: new Date(now.getTime() + 3_600_000),
    })
    .returning();
  if (!session) throw new Error("missing session");
  const identity = { tenant_id: ctx.tenantId, user_id: user.id, session_id: session.id };
  principal = {
    provider: "session",
    kind: "user",
    id: user.id,
    tenant_id: ctx.tenantId,
    roles: ["admin"],
    session_id: session.id,
  };
  grantRequest = new Request("https://example.test/grant", {
    method: "POST",
    headers: {
      cookie: browserSessionCookie(await signBrowserSession(identity)),
      "x-subkit-csrf": await signBrowserCsrf(identity),
    },
  });
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 70: a refused report is repaired by a reviewed deterministic fix", () => {
  test("AC1–AC3 over HTTP: diagnose, propose once, preview, approve, send", async () => {
    const wf = await seedWorkflow(ctx, {
      slug: "finding-mail",
      name: "Finding mail",
      steps: steps(),
    });
    const refused = await grantAndRun(wf.id);
    expect(refused.result.status).toBe("failed");
    expect(refused.sends).toBe(0);

    const before = await diagnosis(wf.id);
    const block = before.find((entry) => entry.subject.step_id === "send_email");
    expect(block).toMatchObject({
      reason: "not_utf8",
      remedy_kind: "patch",
      fixer: "use_utf8_encoder",
    });
    expect(block?.evidence.execution_id).toBe(refused.result.execution_id);
    expect(block?.candidate_id).toBeUndefined();

    const propose = () =>
      journeyFetch(ctx, `/v1/workflows/${wf.id}/repairs`, {
        method: "POST",
        body: JSON.stringify({
          step_id: "send_email",
          fixer: "use_utf8_encoder",
          environment: "dev",
        }),
      });
    const first = await propose();
    expect(first.status).toBe(201);
    const { candidate_id } = (await first.json()) as { candidate_id: string };
    const second = await propose();
    expect(second.status).toBe(200);
    expect(((await second.json()) as { candidate_id: string }).candidate_id).toBe(candidate_id);
    const attached = (await diagnosis(wf.id)).find(
      (entry) => entry.subject.step_id === "send_email",
    );
    expect(attached?.candidate_id).toBe(candidate_id);

    const previewRes = await journeyFetch(ctx, `/v1/patch-candidates/${candidate_id}/preview`);
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as {
      reviewable: boolean;
      review_digest: string;
      before_step: { id: string; expression?: string };
      after_step: { id: string; expression?: string };
    };
    expect(preview.reviewable).toBe(true);
    expect(preview.before_step.id).toBe("compose");
    expect(preview.before_step.expression).toContain("sk.base64UrlEncode(msg)");
    expect(preview.after_step.expression).toContain("sk.base64UrlEncodeUtf8(msg)");
    const dryRun = await journeyFetch(ctx, `/v1/patch-candidates/${candidate_id}/dry-run`, {
      method: "POST",
    });
    expect(dryRun.status).toBe(409);
    expect(((await dryRun.json()) as { code?: string }).code).toBe("not_replayable");
    const approve = await journeyFetch(ctx, `/v1/patch-candidates/${candidate_id}/approve`, {
      method: "POST",
      body: JSON.stringify({ expected_review_digest: preview.review_digest }),
    });
    expect(approve.status).toBe(200);
    const applied = (await approve.json()) as { applied: boolean; workflow_version_id: string };
    expect(applied.applied).toBe(true);
    expect(await currentVersion(wf.id)).toBe(applied.workflow_version_id);

    const repaired = await grantAndRun(wf.id);
    expect(repaired.result.status).toBe("succeeded");
    expect(repaired.sends).toBe(1);
    expect((await diagnosis(wf.id)).filter((entry) => entry.fixer)).toEqual([]);
  });

  test("AC4 over MCP: diagnose_workflow and propose_workflow_repair", async () => {
    const wf = await seedWorkflow(ctx, {
      slug: "finding-mail-mcp",
      name: "Finding mail MCP",
      steps: steps(),
    });
    await grantAndRun(wf.id);
    const client = await connect();
    try {
      const diagnosed = toolData(
        await client.callTool({
          name: "diagnose_workflow",
          arguments: { workflow_id: wf.id, environment: "dev" },
        }),
      );
      const diagnoses = ((diagnosed.data ?? diagnosed) as { diagnoses?: Diagnosis[] }).diagnoses;
      expect(diagnoses?.find((entry) => entry.subject.step_id === "send_email")).toMatchObject({
        reason: "not_utf8",
        fixer: "use_utf8_encoder",
      });
      const proposed = toolData(
        await client.callTool({
          name: "propose_workflow_repair",
          arguments: {
            workflow_id: wf.id,
            environment: "dev",
            step_id: "send_email",
            fixer: "use_utf8_encoder",
          },
        }),
      );
      const candidate_id = ((proposed.data ?? proposed) as { candidate_id?: string }).candidate_id;
      expect(typeof candidate_id).toBe("string");
      const res = await journeyFetch(ctx, `/v1/patch-candidates/${candidate_id}/preview`);
      expect(res.status).toBe(200);
    } finally {
      await client.close();
    }
  });
  test("AC5: a reasonless refusal is prepared, then named and fixable", async () => {
    const wf = await seedWorkflow(ctx, {
      slug: "finding-mail-legacy",
      name: "Finding mail legacy",
      steps: steps(),
    });
    const refused = await grantAndRun(wf.id);
    expect(refused.result.status).toBe("failed");
    await ctx.db
      .update(executionSteps)
      .set({ error: sql`${executionSteps.error} - 'reason'` })
      .where(
        and(
          eq(executionSteps.tenant_id, ctx.tenantId),
          eq(executionSteps.execution_id, refused.result.execution_id),
        ),
      );
    const before = (await diagnosis(wf.id)).find((entry) => entry.subject.step_id === "send_email");
    expect(before).toMatchObject({ code: "execution_authority_changed", remedy_kind: "prepare" });
    expect(before?.reason).toBeUndefined();

    const version_id = await currentVersion(wf.id);
    const prepared = await withDriverFetchForTests(
      Object.assign(async () => Response.json({ id: "held" }), {
        preconnect: () => {},
      }) as typeof fetch,
      () =>
        journeyFetch(ctx, `/v1/workflows/${wf.id}/versions/${version_id}/prepare-authority`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ environment: "dev", input: { at: "2026-01-01T00:00:00Z" } }),
        }),
    );
    const body = (await prepared.json()) as { prepared?: boolean; reason?: string };
    expect(body.reason).not.toBe("already_bindable");
    expect(body.prepared).toBe(true);

    const after = (await diagnosis(wf.id)).find((entry) => entry.subject.step_id === "send_email");
    expect(after).toMatchObject({
      reason: "not_utf8",
      remedy_kind: "patch",
      fixer: "use_utf8_encoder",
    });
  });
  test("AC6: the preparation replays the refused run's delivery", async () => {
    const wf = await seedWorkflow(ctx, {
      slug: "finding-mail-branching",
      name: "Finding mail branching",
      steps: [
        {
          kind: "transform",
          id: "kind",
          language: "javascript",
          expression: "return { k: input.input.kind ?? 'heartbeat' };",
        },
        {
          kind: "branch",
          id: "worth_telling",
          when: "kind.data.k = 'finding'",
          then_steps: ["compose", "send_email"],
          else_steps: [],
        },
        ...steps(),
      ],
    });
    const refused = await grantAndRun(wf.id, { at: "2026-01-01T00:00:00Z", kind: "finding" });
    expect(refused.result.status).toBe("failed");
    await ctx.db
      .update(executionSteps)
      .set({ error: sql`${executionSteps.error} - 'reason'` })
      .where(
        and(
          eq(executionSteps.tenant_id, ctx.tenantId),
          eq(executionSteps.execution_id, refused.result.execution_id),
        ),
      );
    const version_id = await currentVersion(wf.id);
    const prepared = await withDriverFetchForTests(
      Object.assign(async () => Response.json({ id: "held" }), {
        preconnect: () => {},
      }) as typeof fetch,
      () =>
        journeyFetch(ctx, `/v1/workflows/${wf.id}/versions/${version_id}/prepare-authority`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ environment: "dev" }),
        }),
    );
    expect(((await prepared.json()) as { prepared?: boolean }).prepared).toBe(true);
    const after = (await diagnosis(wf.id)).find((entry) => entry.subject.step_id === "send_email");
    expect(after).toMatchObject({ reason: "not_utf8", fixer: "use_utf8_encoder" });
  });
});
