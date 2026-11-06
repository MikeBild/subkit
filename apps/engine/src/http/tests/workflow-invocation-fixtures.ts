import { afterAll, beforeAll } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiKeys, users, webhooksInbound } from "../../db/schema/index.ts";
import { builtinRoleId, createRole, grantPermissionToRole } from "../../rbac/roles.ts";
import { withConfigKey } from "../../test-helpers/config-override.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

export const PUBLIC_URL = "https://engine.example.com";

export const SECRET_MARK = "hook-signing-secret-never-returned";

export let ctx: HttpTestServer;

let counter = 0;

let readers = 0;

export const headers = (key = ctx.apiKey): Record<string, string> => ({
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

export async function createWorkflow(extra: Record<string, unknown> = {}) {
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

export async function invocation(id: string, key = ctx.apiKey, publicUrl = `${PUBLIC_URL}/`) {
  return withConfigKey("server.public_base_url", publicUrl, async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/workflows/${id}/invocation`, {
      headers: headers(key),
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Invocation };
  });
}

export function curlBody(snippet: string): unknown {
  const word = snippet.slice(snippet.lastIndexOf("  -d ") + "  -d ".length);
  if (!word.startsWith("'") || !word.endsWith("'")) throw new Error(`not one quoted word: ${word}`);
  return JSON.parse(word.slice(1, -1).replaceAll(`'\\''`, "'"));
}

export async function bindHook(
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

export async function reader(
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

export const LEGACY_STEPS = {
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

export function setupWorkflowInvocation(): void {
  counter = 0;
  readers = 0;
  beforeAll(async () => {
    ctx = await createHttpTestServer("workflow_invocation");
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
}
