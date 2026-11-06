import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { renderInvokeSnippet } from "@shared/invoke-snippet.ts";
import { and, eq, sql } from "drizzle-orm";
import {
  apiKeys,
  users,
  webhooksInbound,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { grantResource } from "../../rbac/index.ts";
import { builtinRoleId, createRole, grantPermissionToRole } from "../../rbac/roles.ts";
import { withConfigKey } from "../../test-helpers/config-override.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { createWorkflow as createWorkflowIn } from "../../workflows/index.ts";
import { RunBodySchema } from "../routes/executions/schemas.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const PUBLIC_URL = "https://engine.example.com";
const SECRET_MARK = "hook-signing-secret-never-returned";

let ctx: HttpTestServer;
let counter = 0;
let readers = 0;

beforeAll(async () => {
  ctx = await createHttpTestServer("workflow_invocation");
});

afterAll(async () => {
  await ctx.cleanup();
});

const headers = (key = ctx.apiKey): Record<string, string> => ({
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
});

interface Invocation {
  start_access: {
    permission: string;
    caller: { allowed: boolean; source: string | null; reason: string | null };
    visibility: { rules: boolean };
    rules?: {
      roles: Array<{ id: string; name: string }>;
      grants: Array<{ subject_type: string; subject_id: string; expires_at: string | null }>;
    };
    external: { authentication_required: boolean; credential_restrictions_apply: boolean };
    without_approval: string;
  };
  workflow_id: string;
  slug: string;
  invalid: boolean;
  visibility: { hooks: boolean; schedules: boolean };
  base_url: string | null;
  http: {
    method: string;
    path: string;
    url: string | null;
    headers: string[];
    body: { source: string; workflow_id: string; input: Record<string, unknown> };
    snippets: Record<"dev" | "prod", Record<"curl" | "node" | "python", string>> | null;
  };
  hooks?: Array<{
    slug: string;
    path: string;
    url: string | null;
    verifier: string;
    signed: boolean;
    signing_headers: string[];
    hmac: Record<string, string> | null;
    state: string;
    environment: string;
  }>;
  mcp: {
    tool_name: string;
    fallback: { tool_name: string; arguments: { workflow: string; input: unknown } };
  };
  schedules?: Array<{
    cron: string;
    timezone: string;
    environment: string;
    input: unknown;
    state: string;
    next_fire_at: string | null;
  }>;
  cli: { command: string; environment: string };
  input: {
    source: string;
    schema: Record<string, unknown> | null;
    sample: Record<string, unknown>;
  };
  output: { schema: Record<string, unknown> | null };
  webhook_input_shape: Record<string, string>;
  authority: Record<"dev" | "prod", string>;
}

async function createWorkflow(extra: Record<string, unknown> = {}) {
  counter += 1;
  const res = await fetch(`${ctx.baseUrl}/v1/workflows`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      name: `invocation-${counter}`,
      steps: [{ kind: "transform", id: "out", expression: "return { ok: true };" }],
      ...extra,
    }),
  });
  if (!res.ok) throw new Error(`workflow create failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; slug: string; current_version_id: string };
}

async function invocation(id: string, key = ctx.apiKey, publicUrl = `${PUBLIC_URL}/`) {
  return withConfigKey("server.public_base_url", publicUrl, async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/workflows/${id}/invocation`, {
      headers: headers(key),
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Invocation };
  });
}

function curlBody(snippet: string): unknown {
  const word = snippet.slice(snippet.lastIndexOf("  -d ") + "  -d ".length);
  if (!word.startsWith("'") || !word.endsWith("'")) throw new Error(`not one quoted word: ${word}`);
  return JSON.parse(word.slice(1, -1).replaceAll(`'\\''`, "'"));
}

async function bindHook(
  workflowId: string,
  slug: string,
  verifier: string,
  config: Record<string, unknown> | null,
  extra: Partial<typeof webhooksInbound.$inferInsert> = {},
) {
  await ctx.db.insert(webhooksInbound).values({
    tenant_id: ctx.tenantId,
    workflow_id: workflowId,
    slug,
    verifier,
    native_verifier_config: config,
    secret_ciphertext: Buffer.from(SECRET_MARK),
    secret_iv: Buffer.from(SECRET_MARK),
    secret_auth_tag: Buffer.from(SECRET_MARK),
    ...extra,
  });
}

async function reader(
  name: string,
  permissions: string[],
  scopes: string[] = ["*"],
): Promise<string> {
  const role = await createRole(ctx.db, ctx.tenantId, `invocation-${name}`);
  for (const permission of permissions)
    await grantPermissionToRole(ctx.db, ctx.tenantId, role.id, permission);
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: `invocation-${name}@test.local`,
      role_id: await builtinRoleId(ctx.db, "member"),
    })
    .returning();
  if (!user) throw new Error("missing user fixture");
  await ctx.db.update(users).set({ role_id: role.id }).where(eq(users.id, user.id));
  readers += 1;
  const key = `wf_live_i${String(readers).padStart(3, "0")}_invocation_${name}`;
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: user.id,
    prefix: key.slice(0, 12),
    token_sha256: createHash("sha256").update(key).digest("hex"),
    scopes,
  });
  return key;
}

describe("GET /v1/workflows/{id}/invocation", () => {
  test("a request workflow: the run call, from the configured public address", async () => {
    const wf = await createWorkflow({
      input_schema: {
        type: "object",
        properties: {
          recipient_email: { type: "string" },
          limit: { type: "integer", default: 5 },
          note: { type: "string" },
        },
        required: ["recipient_email", "limit"],
      },
      output_schema: { type: "object", properties: { ok: { type: "boolean" } } },
    });
    const { status, body } = await invocation(wf.id);
    expect(status).toBe(200);
    expect(body.workflow_id).toBe(wf.id);
    expect(body.slug).toBe(wf.slug);
    expect(body.base_url).toBe(PUBLIC_URL);
    expect(body.http.method).toBe("POST");
    expect(body.http.path).toBe("/v1/executions");
    expect(body.http.url).toBe(`${PUBLIC_URL}/v1/executions`);
    expect(body.http.headers).toEqual(["authorization", "x-subkit-environment", "content-type"]);
    expect(body.http.body).toEqual({
      source: "saved",
      workflow_id: wf.id,
      input: { recipient_email: "<recipient_email>", limit: 5 },
    });
    expect(body.input.source).toBe("declared");
    expect(body.input.sample).toEqual({ recipient_email: "<recipient_email>", limit: 5 });
    expect(body.output.schema).toEqual({ type: "object", properties: { ok: { type: "boolean" } } });
    expect(body.mcp).toEqual({
      tool_name: `wf_${wf.slug}`,
      fallback: {
        tool_name: "run_workflow",
        arguments: { workflow: wf.slug, input: body.input.sample },
      },
    });
    expect(body.cli).toEqual({
      command: `sk workflows run ${wf.slug} --input '${JSON.stringify(body.input.sample)}'`,
      environment: "dev",
    });
    expect(body.hooks).toEqual([]);
    expect(body.schedules).toEqual([]);
    expect(body.webhook_input_shape).toEqual({
      id: "string",
      type: "string",
      timestamp: "number",
      headers: "object",
      body: "json",
    });
    expect(body.authority).toEqual({ dev: "held_preview_only", prod: "held_preview_only" });
  });

  test("the snippets are the shared renderer's bytes for the same inputs", async () => {
    const wf = await createWorkflow({ input_schema_sample: { city: "Leipzig", days: 3 } });
    const { body } = await invocation(wf.id);
    expect(body.input.sample).toEqual({ city: "Leipzig", days: 3 });
    for (const environment of ["dev", "prod"] as const)
      for (const lang of ["curl", "node", "python"] as const)
        expect(body.http.snippets?.[environment][lang]).toBe(
          renderInvokeSnippet({
            lang,
            engineUrl: PUBLIC_URL,
            workflowId: wf.id,
            environment,
            input: { city: "Leipzig", days: 3 },
          }),
        );
    expect(body.http.snippets?.prod.curl).toContain("x-subkit-environment: prod");
    expect(body.http.snippets?.prod.curl).not.toContain("x-subkit-tenant");
  });

  test("a workflow that reads no input says so", async () => {
    const wf = await createWorkflow();
    const { body } = await invocation(wf.id);
    expect(body.input).toEqual({ source: "none", schema: null, sample: {} });
    expect(body.output.schema).toBeNull();
    expect(body.http.body.input).toEqual({});
  });

  test("a schedule: cron, timezone, environment, fixed input and the next fire", async () => {
    const wf = await createWorkflow();
    const res = await fetch(`${ctx.baseUrl}/v1/schedules`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        workflow_id: wf.id,
        cron: "0 7 * * *",
        timezone: "Europe/Berlin",
        input: { report: "daily" },
      }),
    });
    expect(res.status).toBe(201);
    const { body } = await invocation(wf.id);
    expect(body.schedules).toHaveLength(1);
    const schedule = body.schedules?.[0];
    expect(schedule?.cron).toBe("0 7 * * *");
    expect(schedule?.timezone).toBe("Europe/Berlin");
    expect(schedule?.input).toEqual({ report: "daily" });
    expect(["dev", "prod"]).toContain(schedule?.environment ?? "");
    expect(schedule?.state).toBe("active");
    expect(schedule?.next_fire_at).not.toBeNull();
  });

  test("a hook with a fixed scheme: its address and the headers a delivery carries", async () => {
    const wf = await createWorkflow();
    await bindHook(wf.id, "invocation-standard", "standard", null);
    await bindHook(wf.id, "invocation-github", "github", null, { active: false });
    const { body } = await invocation(wf.id);
    expect(body.hooks?.map((hook) => hook.slug)).toEqual([
      "invocation-github",
      "invocation-standard",
    ]);
    const standard = body.hooks?.find((hook) => hook.slug === "invocation-standard");
    expect(standard).toEqual({
      slug: "invocation-standard",
      path: "/v1/hooks/invocation-standard",
      url: `${PUBLIC_URL}/v1/hooks/invocation-standard`,
      verifier: "standard",
      signed: true,
      signing_headers: ["webhook-id", "webhook-timestamp", "webhook-signature"],
      hmac: null,
      state: "active",
      environment: "prod",
    });
    const github = body.hooks?.find((hook) => hook.slug === "invocation-github");
    expect(github?.signing_headers).toEqual([
      "x-hub-signature-256",
      "x-github-delivery",
      "x-github-event",
    ]);
    expect(github?.state).toBe("inactive");
  });

  test("a generic HMAC hook names the sender's own headers and scheme", async () => {
    const wf = await createWorkflow();
    await bindHook(
      wf.id,
      "invocation-hmac",
      "hmac",
      {
        hmac: {
          signature_header: "X-Example-Signature",
          signature_prefix: "sha256=",
          encoding: "hex",
          signed_payload: "{timestamp}.{body}",
          timestamp_header: "X-Example-Timestamp",
          id_header: "X-Example-Delivery",
        },
      },
      {
        admission_hold: {
          reason_code: "execution_authority_required",
          observed_at: "2030-01-01T00:00:00.000Z",
        },
      },
    );
    const { body } = await invocation(wf.id);
    expect(body.hooks).toEqual([
      {
        slug: "invocation-hmac",
        path: "/v1/hooks/invocation-hmac",
        url: `${PUBLIC_URL}/v1/hooks/invocation-hmac`,
        verifier: "hmac",
        signed: true,
        signing_headers: ["x-example-signature", "x-example-delivery", "x-example-timestamp"],
        hmac: {
          algorithm: "sha256",
          encoding: "hex",
          signed_payload: "{timestamp}.{body}",
          signature_prefix: "sha256=",
        },
        state: "held",
        environment: "prod",
      },
    ]);
  });

  test("a hook that accepts unsigned deliveries says so", async () => {
    const wf = await createWorkflow();
    await bindHook(wf.id, "invocation-unsigned", "standard", { skip: true });
    const { body } = await invocation(wf.id);
    expect(body.hooks?.[0]).toMatchObject({ signed: false, signing_headers: [], hmac: null });
  });

  test("no response carries a hook's signing secret, a key or a token", async () => {
    const wf = await createWorkflow();
    await bindHook(wf.id, "invocation-secret", "standard", null);
    const { text } = await invocation(wf.id);
    expect(text).not.toContain(SECRET_MARK);
    expect(text).not.toContain(Buffer.from(SECRET_MARK).toString("base64"));
    expect(text).not.toContain(Buffer.from(SECRET_MARK).toString("hex"));
    expect(text).not.toContain(ctx.apiKey);
    for (const word of ["secret_ciphertext", "secret_iv", "secret_auth_tag", "ciphertext"])
      expect(text).not.toContain(word);
    expect(text).toContain("SK_API_KEY");
  });

  test("a stored approval for the running version makes that environment live", async () => {
    const wf = await createWorkflow();
    await ctx.db.insert(workflowExecutionAuthorities).values({
      tenant_id: ctx.tenantId,
      workflow_id: wf.id,
      workflow_version_id: wf.current_version_id,
      effect_manifest_digest: "d".repeat(64),
      effect_manifest: {},
      execution_environment: "prod",
      target_constraints: { targets: [] },
      valid_until: sql`clock_timestamp() + interval '1 day'`,
      max_runs: 3,
      created_by: ctx.userId,
    });
    expect((await invocation(wf.id)).body.authority).toEqual({
      dev: "held_preview_only",
      prod: "live_run_allowed",
    });
    await ctx.db
      .update(workflowExecutionAuthorities)
      .set({ reserved_runs: 3 })
      .where(eq(workflowExecutionAuthorities.workflow_id, wf.id));
    expect((await invocation(wf.id)).body.authority.prod).toBe("held_preview_only");
  });

  test("bindings appear only with the permission that shows them elsewhere", async () => {
    const wf = await createWorkflow();
    await bindHook(wf.id, "invocation-projected", "standard", null);
    const plain = await invocation(wf.id, await reader("plain", ["workflow:read"]));
    expect(plain.status).toBe(200);
    expect("hooks" in plain.body).toBe(false);
    expect("schedules" in plain.body).toBe(false);
    expect(plain.body.visibility).toEqual({ hooks: false, schedules: false });
    expect(plain.text).not.toContain("invocation-projected");
    expect(plain.body.http.url).toBe(`${PUBLIC_URL}/v1/executions`);

    const hooks = await invocation(
      wf.id,
      await reader("hooks", ["workflow:read", "inbound_hook:read"]),
    );
    expect(hooks.body.hooks?.map((hook) => hook.slug)).toEqual(["invocation-projected"]);
    expect("schedules" in hooks.body).toBe(false);
    expect(hooks.body.visibility).toEqual({ hooks: true, schedules: false });

    const schedules = await invocation(
      wf.id,
      await reader("schedules", ["workflow:read", "schedule:read"]),
    );
    expect(schedules.body.schedules).toEqual([]);
    expect("hooks" in schedules.body).toBe(false);
    expect(schedules.body.visibility).toEqual({ hooks: false, schedules: true });

    const all = await invocation(wf.id);
    expect(all.body.visibility).toEqual({ hooks: true, schedules: true });
  });

  test("a caller who may not read the workflow is refused", async () => {
    const wf = await createWorkflow();
    const res = await fetch(`${ctx.baseUrl}/v1/workflows/${wf.id}/invocation`, {
      headers: headers(await reader("none", ["connector:read"])),
    });
    expect(res.status).toBe(403);
  });

  test("an unknown workflow is not found", async () => {
    const { status } = await invocation("00000000-0000-4000-8000-00000000f001");
    expect(status).toBe(404);
  });

  test("without a configured public address no URL is invented", async () => {
    const wf = await createWorkflow();
    await bindHook(wf.id, "invocation-no-address", "standard", null);
    const { body, text } = await invocation(wf.id, ctx.apiKey, "");
    expect(body.base_url).toBeNull();
    expect(body.http.url).toBeNull();
    expect(body.http.snippets).toBeNull();
    expect(body.http.path).toBe("/v1/executions");
    expect(body.hooks?.[0]?.url).toBeNull();
    expect(body.hooks?.[0]?.path).toBe("/v1/hooks/invocation-no-address");
    expect(text).not.toContain(new URL(ctx.baseUrl).host);
  });

  test("another tenant's workflow is not found", async () => {
    const other = await seedTenant(ctx.db, {
      slug: "invocation-other-tenant",
      display_name: "Other tenant",
    });
    const foreign = await createWorkflowIn(
      {
        tenant_id: other.id,
        actor_id: null,
        def: {
          name: "invocation-foreign",
          steps: [{ kind: "transform", id: "out", expression: "return { ok: true };" }],
        },
      },
      ctx.db,
    );
    if (!foreign.workflow) throw new Error(`foreign workflow invalid: ${foreign.errors}`);
    const [row] = await ctx.db
      .select({ tenant_id: workflows.tenant_id })
      .from(workflows)
      .where(eq(workflows.id, foreign.workflow.id));
    expect(row?.tenant_id).toBe(other.id);

    const { status, text } = await invocation(foreign.workflow.id);
    expect(status).toBe(404);
    expect(text).not.toContain("invocation-foreign");
  });
});

describe("the run request the snippets send", () => {
  test("every snippet's body is one the run route accepts", async () => {
    const wf = await createWorkflow({
      input_schema: {
        type: "object",
        properties: { recipient_email: { type: "string" }, limit: { type: "integer", default: 5 } },
        required: ["recipient_email", "limit"],
      },
    });
    const { body } = await invocation(wf.id);
    for (const environment of ["dev", "prod"] as const) {
      const sent = RunBodySchema.parse(curlBody(body.http.snippets?.[environment].curl ?? ""));
      expect(sent).toMatchObject({
        source: "saved",
        workflow_id: wf.id,
        input: { recipient_email: "<recipient_email>", limit: 5 },
      });
    }
    expect(RunBodySchema.parse(body.http.body)).toMatchObject({ source: "saved" });
  });

  test("a sample key named __proto__ reaches the body in every language", async () => {
    const wf = await createWorkflow({
      input_schema: {
        type: "object",
        properties: { ["__proto__"]: { type: "string" }, name: { type: "string" } },
        required: ["__proto__", "name"],
      },
    });
    const { body } = await invocation(wf.id);
    expect(Object.keys(body.input.sample).sort()).toEqual(["__proto__", "name"]);
    const snippets = body.http.snippets?.prod;
    expect(Object.keys((curlBody(snippets?.curl ?? "") as { input: object }).input).sort()).toEqual(
      ["__proto__", "name"],
    );
    expect(snippets?.node).toContain(`["__proto__"]: "<__proto__>"`);
    expect(snippets?.python).toContain(`"__proto__": "<__proto__>"`);
  });
});

describe("the copyable command", () => {
  async function commandFor(slug: string): Promise<{ id: string; command: string }> {
    const wf = await createWorkflow();
    await ctx.db.update(workflows).set({ slug }).where(eq(workflows.id, wf.id));
    return { id: wf.id, command: (await invocation(wf.id)).body.cli.command };
  }

  test.each(["x'; touch /tmp/owned; echo '", "$(touch /tmp/owned)", "a b", "--help", "a`id`"])(
    "a slug a shell would not read as one plain word is never printed: %s",
    async (slug) => {
      const { id, command } = await commandFor(slug);
      expect(command).not.toContain(slug);
      expect(command).toBe(`sk workflows run ${id} --input '{}'`);
    },
  );

  test("a plain slug is printed as it is", async () => {
    const { command } = await commandFor("daily-report_2");
    expect(command).toBe("sk workflows run daily-report_2 --input '{}'");
  });

  test("an apostrophe in the sample cannot end the input word early", async () => {
    const wf = await createWorkflow({ input_schema_sample: { note: "it's $HOME" } });
    const { body } = await invocation(wf.id);
    expect(body.cli.command).toBe(
      `sk workflows run ${wf.slug} --input '{"note":"it'\\''s $HOME"}'`,
    );
  });
});

const LEGACY_STEPS = {
  "a retired transform language": [
    {
      kind: "transform",
      id: "old",
      language: "jsonata",
      expression: "$.items[city = $input.city]",
    },
  ],
  "a retired step kind": [{ kind: "retired_step_kind", id: "old", note: "an earlier schema" }],
} as const;

describe.each(Object.entries(LEGACY_STEPS))(
  "a workflow whose current version is stored in an earlier format — %s",
  (_shape, steps) => {
    async function invalidWorkflow() {
      const wf = await createWorkflow({ description: "kept readable" });
      await ctx.db
        .update(workflowVersions)
        .set({
          dag: {
            name: "invalid",
            description: "kept readable",
            trigger: { kind: "schedule", cron: "0 6 * * *" },
            input_schema: { type: "object", properties: { city: { type: "string" } } },
            steps,
          },
        })
        .where(eq(workflowVersions.id, wf.current_version_id));
      return wf;
    }

    test("is still readable: the workflow, the list it is a row of, and how to call it", async () => {
      const wf = await invalidWorkflow();

      const single = await fetch(`${ctx.baseUrl}/v1/workflows/${wf.id}`, { headers: headers() });
      expect(single.status).toBe(200);
      const view = (await single.json()) as { invalid: boolean; steps: Array<{ id: string }> };
      expect(view.invalid).toBe(true);
      expect(view.steps.map((step) => step.id)).toEqual(["old"]);

      const list = await fetch(`${ctx.baseUrl}/v1/workflows?limit=200`, { headers: headers() });
      expect(list.status).toBe(200);
      const items = ((await list.json()) as { items: Array<{ id: string; invalid: boolean }> })
        .items;
      expect(items.find((item) => item.id === wf.id)?.invalid).toBe(true);
      expect(items.some((item) => item.id !== wf.id && item.invalid === false)).toBe(true);

      const called = await invocation(wf.id);
      expect(called.status).toBe(200);
      expect(called.body.invalid).toBe(true);
      expect(called.body.http.body.workflow_id).toBe(wf.id);
      expect(called.body.input.sample).toEqual({ city: "<city>" });
    });

    test("is refused by name when it is run", async () => {
      const wf = await invalidWorkflow();
      const res = await fetch(`${ctx.baseUrl}/v1/executions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ source: "saved", workflow_id: wf.id, input: {} }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        code: string;
        message: string;
        details?: { issues?: Array<{ step_id: string }> };
      };
      expect(body.code).toBe("workflow_version_invalid");
      expect(body.message).toContain("earlier definition format");
      expect(body.details?.issues?.[0]?.step_id).toBe("old");
    });

    test("a current-format workflow says it is not invalid", async () => {
      const wf = await createWorkflow();
      expect((await invocation(wf.id)).body.invalid).toBe(false);
    });
  },
);

describe("workflow start access", () => {
  test("reports the authenticated caller permission independently from effect approvals", async () => {
    const wf = await createWorkflow();
    const { body } = await invocation(wf.id);
    expect(body.start_access.caller.allowed).toBe(true);
    expect(body.start_access.permission).toBe("workflow:run");
    expect(body.start_access.rules?.roles.some((role) => role.name === "admin")).toBe(true);
    expect(body.start_access.external).toEqual({
      authentication_required: true,
      credential_restrictions_apply: true,
    });
    expect(body.start_access.without_approval).toBe("held_preview_only");
    expect(body.authority).toEqual({ dev: "held_preview_only", prod: "held_preview_only" });
  });

  test("does not expose permission rules to readers and honors credential scope ceilings", async () => {
    const wf = await createWorkflow();
    const key = await reader(
      "restricted-run",
      ["workflow:read", "workflow:run", "rbac:read"],
      ["workflow:read"],
    );
    const { status, body } = await invocation(wf.id, key);
    expect(status).toBe(200);
    expect(body.start_access.caller).toEqual({
      allowed: false,
      source: "credential_ceiling",
      reason: "credential_ceiling:scope_not_granted",
    });
    expect(body.start_access.visibility.rules).toBe(false);
    expect(body.start_access).not.toHaveProperty("rules");
  });

  test("includes only unexpired start grants for this workflow and this tenant", async () => {
    const wf = await createWorkflow();
    const other = await createWorkflow();
    const subject = "10000000-0000-4000-8000-000000000001";
    const expiredSubject = "10000000-0000-4000-8000-000000000002";
    const otherSubject = "10000000-0000-4000-8000-000000000003";
    const base = {
      tenant_id: ctx.tenantId,
      subject_type: "user" as const,
      resource_type: "workflow",
      permission: "workflow:run",
    };
    await grantResource(ctx.db, { ...base, subject_id: subject, resource_id: wf.id });
    await grantResource(ctx.db, {
      ...base,
      subject_id: expiredSubject,
      resource_id: wf.id,
      expires_at: new Date("2000-01-01T00:00:00Z"),
    });
    await grantResource(ctx.db, { ...base, subject_id: otherSubject, resource_id: other.id });
    const foreignTenant = await seedTenant(ctx.db, {
      slug: "invocation-foreign-rules",
      display_name: "Foreign",
    });
    await grantResource(ctx.db, {
      ...base,
      tenant_id: foreignTenant.id,
      subject_id: otherSubject,
      resource_id: wf.id,
    });
    const { body } = await invocation(wf.id);
    expect(body.start_access.rules?.grants).toEqual([
      { subject_type: "user", subject_id: subject, expires_at: null },
    ]);
  });
});

describe("workflow operating status list", () => {
  test("filters and counts before paging, preserves lifecycle and reports unreadable facts as unknown", async () => {
    const first = await createWorkflow({ name: "operating-http-a" });
    const archived = await createWorkflow({ name: "operating-http-b" });
    const second = await createWorkflow({ name: "operating-http-c" });
    const archivedLater = await createWorkflow({ name: "operating-http-d" });
    for (const workflow of [archived, archivedLater]) {
      await ctx.db
        .update(workflows)
        .set({ lifecycle: "archived" })
        .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, workflow.id)));
    }
    const query = "q=operating-http-&operating_status=disabled&sort=name&order=asc&limit=1";
    const fetchPage = async (offset: number) => {
      const response = await fetch(`${ctx.baseUrl}/v1/workflows?${query}&offset=${offset}`, {
        headers: headers(),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        total: number;
        items: Array<{ id: string; lifecycle: string; operating_status: string }>;
      };
    };
    const page = await fetchPage(0);
    const next = await fetchPage(1);
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: archived.id,
      lifecycle: "archived",
      operating_status: "disabled",
    });
    expect(next.total).toBe(2);
    expect(next.items[0]?.id).toBe(archivedLater.id);
    expect((await fetchPage(2)).items).toEqual([]);
    const readerKey = await reader("operating-status-reader", ["workflow:read"]);
    const restricted = await fetch(
      `${ctx.baseUrl}/v1/workflows?q=operating-http-&operating_status=unknown`,
      { headers: headers(readerKey) },
    );
    expect(restricted.status).toBe(200);
    const restrictedBody = (await restricted.json()) as {
      total: number;
      items: Array<{ id: string; operating_status: string }>;
    };
    expect(restrictedBody.total).toBe(2);
    expect(restrictedBody.items.map((item) => item.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(restrictedBody.items.every((item) => item.operating_status === "unknown")).toBe(true);
  });
});
