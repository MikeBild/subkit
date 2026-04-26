import { z } from "@hono/zod-openapi";
import { recordConnectorDraftCredentialRejected } from "../../audit/recorders/index.ts";
import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import { log } from "../../logging/logger.ts";
import { SECRET_PATTERNS, SENSITIVE_KEY_PATTERN } from "../../logging/scrub-secrets.ts";
import { withConnectorDraft } from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import type { ConnectorDraftDocument } from "../types.ts";
import { buildDraftMutationPayload } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

/**
 * Sensitive key names that must NOT appear in `config`. The scrubber's
 * SENSITIVE_KEY_PATTERN is substring-anchored (e.g. `bot_token`, `client_secret`
 * all match). We extend it to a full-word anchor pattern so `static_headers`
 * with an `Authorization` key is caught regardless of nesting.
 */
const CREDENTIAL_KEY_RE =
  /^(token|api[_-]?key|password|credential|secret|.*_token|authorization|access[_-]?token|client[_-]?secret|private[_-]?key)$/i;

/**
 * Walk `value` recursively and return the key path of the first credential-shaped
 * field found, or `null` if none. A field is credential-shaped when:
 *   a) its key name matches CREDENTIAL_KEY_RE, OR
 *   b) its string value matches any known secret-token pattern.
 *
 * The returned path is used ONLY for logging — the actual value is never echoed.
 */
function containsCredentialShape(value: unknown, path: string, depth: number): string | null {
  if (depth > 12) return null;
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    // Check string value against known token patterns.
    for (const { regex } of SECRET_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(value)) {
        regex.lastIndex = 0;
        return path;
      }
      regex.lastIndex = 0;
    }
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) return null;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    // Key name check — uses the scrubber's SENSITIVE_KEY_PATTERN as the broad
    // net, plus our stricter CREDENTIAL_KEY_RE for full-word anchoring.
    if (SENSITIVE_KEY_PATTERN.test(key) || CREDENTIAL_KEY_RE.test(key)) {
      return childPath;
    }
    const hit = containsCredentialShape(child, childPath, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

const inputSchema = z
  .object({
    name: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    driver: z.enum(["http", "postgres", "s3", "graphql"]).optional(),
    environment: z.enum(["dev", "prod"]).optional(),
    base_url: z.string().optional(),
    dsn: z.string().optional(),
    auth_type: z.enum(["none", "header", "query", "bearer", "basic", "oauth2"]).optional(),
    template_slug: z.string().min(1).nullable().optional(),
    template_name: z.string().min(1).nullable().optional(),
    template_source: z.enum(["builtin", "tenant"]).nullable().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    docs: z.array(z.string()).optional(),
  })
  .openapi("UpdateConnectorDraftToolInput");

export const updateConnectorDraftTool: ConversationTool = {
  name: "update_connector_draft",
  description:
    "Update fields on the current connector draft. Use this after each user answer so the operator can inspect the evolving connector before probing or saving.",
  inputSchema,
  category: "draft_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);

    // Hard-reject any attempt to store a credential-shaped value in config.
    // The only correct path for credentials is ask_user_form(type: password,
    // sensitive: true) followed by save_connector_draft({credential}).
    if (args.config !== undefined) {
      const hitPath = containsCredentialShape(args.config, "", 0);
      if (hitPath !== null) {
        log.connector.draft.credential_rejected({
          conversation_id: ctx.conversation_id,
          tenant_id: ctx.tenant_id,
          matched_key_path: hitPath,
          // Value is intentionally NOT logged — only the path is safe to emit.
        });
        // Wave 4: also land the rejection in the audit log so compliance
        // tooling that scans `audit_log` (rather than tailing structured
        // logs) sees the policy decision. Reason and metadata mirror the
        // structured log line; the value is NEVER recorded. Fire-and-
        // forget — a stub-ctx unit test must not pivot the rejection
        // envelope on whether the audit insert succeeded.
        recordConnectorDraftCredentialRejected({
          tenant_id: ctx.tenant_id,
          actor_id: ctx.actor_id,
          executor: ctx.db,
          conversation_id: ctx.conversation_id,
          matched_key_path: hitPath,
        });
        return {
          ok: false,
          error_code: "credential_must_use_form",
          message:
            "Credentials cannot be set via update_connector_draft. " +
            "Use ask_user_form(type: password, sensitive: true) to collect the value, " +
            "then call save_connector_draft({credential}) — the harness saves the connector " +
            "and credential atomically.",
          next_best_actions: ["ask_user_form", "save_connector_draft"],
        };
      }
    }

    const current = ctx.getDraft().connector ?? {};
    const patch = Object.fromEntries(
      Object.entries(args).filter(([, value]) => value !== undefined),
    ) as Partial<ConnectorDraftDocument>;
    const next: ConnectorDraftDocument = {
      ...current,
      ...patch,
      config: args.config ?? current.config ?? {},
      docs: args.docs ?? current.docs ?? [],
      latest_probe: current.latest_probe ?? null,
      saved_connector_id: current.saved_connector_id ?? null,
    };
    const templates = await listResolvedConnectorTemplates(ctx.db, ctx.tenant_id);
    const validation = validateConnectorDraft(
      next,
      templates.map((entry) => entry.template),
    );
    const nextDraft = withConnectorDraft(
      ctx.getDraft(),
      { ...next, validation },
      "connector_updated",
    );
    await ctx.setDraft(nextDraft);
    return {
      ok: true,
      data: buildDraftMutationPayload(nextDraft, {
        resource_kind: "connector",
        extra: {
          connector: { ...next, validation },
          validation,
        },
      }),
    };
  },
};
