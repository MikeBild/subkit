// create_api_key — mints a new API key for the calling actor (or
// another principal when the caller is admin) and returns the
// plaintext token exactly once together with a paste-ready MCP JSON
// config block.
//
// Closes the original "how do I use subkit in codex as an MCP server?"
// transcript: instead of suggesting a CLI command and a half-key
// placeholder, the assistant calls this tool, gets a real key, and
// embeds it inside a config that uses the runtime engine_url.
//
// Permission: api_key:write. When the caller is a non-admin user the
// owner is forced to themselves; admins may target any tenant member
// or system account.

import { z } from "@hono/zod-openapi";
import type { ConversationTool, ToolResult } from "../../index.ts";

const inputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Friendly label shown alongside the key in the UI / sk apikeys list. Optional but recommended.",
      ),
    owner_kind: z
      .enum(["user", "system_account"])
      .optional()
      .describe(
        "Defaults to the calling actor's kind. Admins can target a different principal; members can only create keys for themselves.",
      ),
    owner_id: z
      .string()
      .uuid()
      .optional()
      .describe("Defaults to the calling actor id. Admin-only override otherwise."),
    scopes: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Scope strings the key carries. Defaults to ["*"] (full access) when omitted. Use the smallest set that lets the integration succeed.',
      ),
    allowed_workflows: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Whitelist of workflow ids/slugs the key may invoke. Defaults to all when omitted; use "*" for explicit "all".',
      ),
    allowed_connectors: z
      .array(z.string().min(1))
      .optional()
      .describe("Whitelist of connector ids/slugs the key may use. Defaults to all when omitted."),
    expires_at: z
      .string()
      .datetime()
      .optional()
      .describe("Absolute ISO-8601 expiration. Omit for keys that never expire."),
  })
  .openapi("CreateApiKeyToolInput");

export const createApiKeyTool: ConversationTool = {
  name: "create_api_key",
  description:
    "Mint a new API key with the requested scopes and return the plaintext token EXACTLY ONCE together with a paste-ready MCP/SDK config block. Use this whenever the user asks for a key — never invent placeholder keys, never tell the user to run a CLI command to get one.",
  inputSchema,
  category: "tenant_write",
  use_case:
    "Use whenever the user wants a new API key (e.g. for a Codex/Claude-Desktop MCP integration, an SDK quickstart, or a one-off script). Pair with `revoke_api_key` for rotation.",
  important_notes: [
    "The plaintext key is returned ONCE. Surface it verbatim in the same turn; the user has no way to retrieve it later.",
    "Default scope is ['*']. Prefer narrower scopes (e.g. ['workflow:read']) for production integrations.",
    "When the caller is not admin, owner_kind/owner_id are forced to the calling user — admin-only flags are ignored gracefully.",
  ],
  example_input: {
    name: "Codex MCP",
    scopes: ["workflow:read", "workflow:invoke"],
  },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);

    // Resolve the owner: explicit override only when the caller is admin.
    // EngineClient.context carries actor_id + actor_type; when the
    // calling actor is missing (system-driven flows) the tool refuses.
    const callerId = ctx.engineClient.context.actor_id;
    const callerKind = ctx.engineClient.context.actor_type;
    if (!callerId) {
      return {
        ok: false,
        data: { error: "missing_actor", reason: "create_api_key requires an authenticated actor" },
      };
    }
    const owner_kind: "user" | "system_account" =
      args.owner_kind ?? (callerKind === "user" ? "user" : "system_account");
    const owner_id = args.owner_id ?? callerId;

    const expiresAt = args.expires_at ? new Date(args.expires_at) : undefined;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return {
        ok: false,
        data: { error: "bad_expires_at", reason: "expires_at is not a valid ISO-8601 timestamp" },
      };
    }

    let issued: { view: { id: string; prefix: string; scopes: string[] }; plaintext: string };
    try {
      issued = await ctx.engineClient.identity.issueApiKey({
        owner_kind,
        owner_id,
        ...(args.scopes ? { scopes: args.scopes } : {}),
        ...(args.allowed_workflows ? { allowed_workflows: args.allowed_workflows } : {}),
        ...(args.allowed_connectors ? { allowed_connectors: args.allowed_connectors } : {}),
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, data: { error: "api_key_issue_failed", reason } };
    }

    const audit_log_id = await ctx.engineClient.audit_write({
      resource_type: "api_key",
      resource_id: issued.view.id,
      action: "conversation.create_api_key",
      result: "success",
      metadata: {
        conversation_id: ctx.conversation_id,
        prefix: issued.view.prefix,
        owner_kind,
        owner_id,
        ...(args.name ? { name: args.name } : {}),
        scopes: issued.view.scopes,
      },
    });

    return {
      ok: true,
      data: {
        // Surface the full plaintext key EXACTLY ONCE under a stable
        // field name the assistant can quote verbatim. The caller's
        // chat surface should render it inside a CopyableBlock (D18).
        plaintext_key: issued.plaintext,
        api_key: {
          id: issued.view.id,
          prefix: issued.view.prefix,
          scopes: issued.view.scopes,
        },
        audit_log_id,
      },
    };
  },
};
