// How to call a workflow, as `GET /v1/workflows/{id}/invocation` reports it.
//
// One case per way in — a plain request workflow, a schedule, an inbound hook
// with a fixed signing scheme, one with a generic HMAC scheme and one that
// accepts unsigned deliveries — and the three things the read must never do:
// name an address the operator did not configure, show bindings the caller
// may not read elsewhere, or carry a secret.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { renderInvokeSnippet } from "@shared/invoke-snippet.ts";
import { eq, sql } from "drizzle-orm";
import { getConfig, setConfigKey } from "../../config/loader.ts";
import {
  apiKeys,
  users,
  webhooksInbound,
  workflowExecutionAuthorities,
} from "../../db/schema/index.ts";
import { createRole, grantPermissionToRole } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const PUBLIC_URL = "https://engine.example.com";
/** Recognisable bytes: if any of them reach a response, the test names them. */
const SECRET_MARK = "hook-signing-secret-never-returned";

let ctx: HttpTestServer;
let priorBaseUrl: string | undefined;
let counter = 0;
let readers = 0;

beforeAll(async () => {
  ctx = await createHttpTestServer("workflow_invocation");
  priorBaseUrl = getConfig().server.public_base_url;
  await setConfigKey("server.public_base_url", `${PUBLIC_URL}/`, { force: true });
});

afterAll(async () => {
  await setConfigKey("server.public_base_url", priorBaseUrl ?? "", { force: true });
  await ctx.cleanup();
});

const headers = (key = ctx.apiKey): Record<string, string> => ({
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
});

interface Invocation {
  workflow_id: string;
  slug: string;
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

async function invocation(id: string, key = ctx.apiKey) {
  const res = await fetch(`${ctx.baseUrl}/v1/workflows/${id}/invocation`, {
    headers: headers(key),
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Invocation };
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

/** A key whose role holds exactly these permissions. */
async function reader(name: string, permissions: string[]): Promise<string> {
  const role = await createRole(ctx.db, ctx.tenantId, `invocation-${name}`);
  for (const permission of permissions)
    await grantPermissionToRole(ctx.db, ctx.tenantId, role.id, permission);
  const [user] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email: `invocation-${name}@test.local`, role: "member" })
    .returning();
  if (!user) throw new Error("missing user fixture");
  await ctx.db.update(users).set({ role_id: role.id }).where(eq(users.id, user.id));
  // The stored prefix is the key's first 12 characters and is unique.
  readers += 1;
  const key = `wf_live_i${String(readers).padStart(3, "0")}_invocation_${name}`;
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: user.id,
    prefix: key.slice(0, 12),
    token_sha256: createHash("sha256").update(key).digest("hex"),
    scopes: ["*"],
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
    // The trailing slash of the configured address does not double up.
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
      // Key order is the stored schema's, not the request's.
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
    // Nothing approved yet: a call runs as a held preview in both halves.
    expect(body.authority).toEqual({ dev: "held_preview_only", prod: "held_preview_only" });
  });

  test("the snippets are the shared renderer's bytes for the same inputs", async () => {
    const wf = await createWorkflow({ input_schema_sample: { city: "Leipzig", days: 3 } });
    const { body } = await invocation(wf.id);
    // The author's own example is the sample, verbatim.
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
    // A deactivated binding receives nothing.
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
          signature_header: "X-Upraft-Signature",
          signature_prefix: "sha256=",
          encoding: "hex",
          signed_payload: "{timestamp}.{body}",
          timestamp_header: "X-Upraft-Timestamp",
          id_header: "X-Upraft-Delivery",
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
        signing_headers: ["x-upraft-signature", "x-upraft-delivery", "x-upraft-timestamp"],
        hmac: {
          algorithm: "sha256",
          encoding: "hex",
          signed_payload: "{timestamp}.{body}",
          signature_prefix: "sha256=",
        },
        // The gate refused its last delivery.
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
    // The only key the snippets name is the placeholder.
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
    // Used up, it no longer admits a live run.
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
    expect(plain.text).not.toContain("invocation-projected");
    // The run call itself needs nothing more than reading the workflow.
    expect(plain.body.http.url).toBe(`${PUBLIC_URL}/v1/executions`);

    const hooks = await invocation(
      wf.id,
      await reader("hooks", ["workflow:read", "inbound_hook:read"]),
    );
    expect(hooks.body.hooks?.map((hook) => hook.slug)).toEqual(["invocation-projected"]);
    expect("schedules" in hooks.body).toBe(false);

    const schedules = await invocation(
      wf.id,
      await reader("schedules", ["workflow:read", "schedule:read"]),
    );
    expect(schedules.body.schedules).toEqual([]);
    expect("hooks" in schedules.body).toBe(false);
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
    await setConfigKey("server.public_base_url", "", { force: true });
    try {
      const { body, text } = await invocation(wf.id);
      expect(body.base_url).toBeNull();
      expect(body.http.url).toBeNull();
      expect(body.http.snippets).toBeNull();
      expect(body.http.path).toBe("/v1/executions");
      expect(body.hooks?.[0]?.url).toBeNull();
      expect(body.hooks?.[0]?.path).toBe("/v1/hooks/invocation-no-address");
      // Never the address the request happened to arrive at.
      expect(text).not.toContain(new URL(ctx.baseUrl).host);
    } finally {
      await setConfigKey("server.public_base_url", `${PUBLIC_URL}/`, { force: true });
    }
  });
});
