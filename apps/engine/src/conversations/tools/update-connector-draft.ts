import { z } from "@hono/zod-openapi";
import { recordConnectorDraftCredentialRejected } from "../../audit/recorders/index.ts";
import { mcpAuthKindForType } from "../../connectors/config-schemas.ts";
import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import { type AuthType, DriverEnum } from "../../connectors/types.ts";
import { log } from "../../logging/logger.ts";
import { SECRET_PATTERNS, SENSITIVE_KEY_PATTERN } from "../../logging/scrub-secrets.ts";
import { withConnectorDraft } from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { clearDraftCredential, getDraftCredential } from "../persistence/draft-credential-cache.ts";
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
 * OAuth2 / Cognito metadata fields that *contain* the substring "token"
 * or "authorization" but are NOT secrets. These are public URLs that
 * the LLM legitimately needs to write to `update_connector_draft.config`
 * when wiring an OAuth2 connector.
 *
 * Pre-fix the credential-leak guard fired on `token_endpoint` (matched
 * `SENSITIVE_KEY_PATTERN.token`) and refused the update — the LLM then
 * couldn't fix the AppSync Cognito config and the operator was stuck.
 */
const NON_SECRET_KEYS = new Set<string>([
  "token_endpoint",
  "authorization_endpoint",
  "token_url",
  "authorization_url",
  "issuer_url",
  "token_auth_method",
  "token_content_type",
]);

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
    // Allow-list: well-known OAuth2 / Cognito *metadata* keys that
    // happen to contain "token" / "authorization" as a substring but
    // carry public URLs / enums, not secrets.
    if (!NON_SECRET_KEYS.has(key.toLowerCase())) {
      // Key name check — uses the scrubber's SENSITIVE_KEY_PATTERN as the broad
      // net, plus our stricter CREDENTIAL_KEY_RE for full-word anchoring.
      if (SENSITIVE_KEY_PATTERN.test(key) || CREDENTIAL_KEY_RE.test(key)) {
        return childPath;
      }
    }
    const hit = containsCredentialShape(child, childPath, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * Top-level config keys the LLM invents to "store the query parameter
 * name" for query auth. None of these exist in any driver's config
 * schema — `HttpConnectorConfig` is `.strict()` and rejects them at save
 * with the opaque "invalid http connector config". The param name lives
 * in the credential's `param` field, never in config.
 *
 * Matched by regex rather than a fixed deny-list so future LLM inventions
 * (`query_arg_name`, `auth_query_param`, …) are caught without a redeploy.
 * To match, a key must carry a *qualifier* — either an `auth_`/`query_`
 * prefix OR at least one `_name`/`_param`/`_parameter`/`_key`/`_arg`
 * trailing segment. A bare generic token on its own (`key`, `token`,
 * `query`, `param`, `arg`) does NOT match, so the detector never collides
 * with an ordinary config key (static_headers, static_query, query_defaults,
 * timeout_ms, oauth, key, token, …).
 * Known matches: query_param_name, query_parameter_name, query_param,
 * param_name, query_key, auth_param, auth_query_param, token_param.
 */
const AUTH_PARAM_CONFIG_KEY_RE =
  /^((auth_|query_)(param|parameter|query|token|key|arg)(_(name|param|parameter|key|arg))*|(param|parameter|query|token|key|arg)(_(name|param|parameter|key|arg))+)$/i;

export function findAuthParamConfigKey(config: Record<string, unknown>): string | null {
  for (const key of Object.keys(config)) {
    if (AUTH_PARAM_CONFIG_KEY_RE.test(key)) return key;
  }
  return null;
}

const inputSchema = z
  .object({
    name: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    driver: DriverEnum.optional(),
    environment: z.enum(["dev", "prod"]).optional(),
    base_url: z.string().optional(),
    dsn: z.string().optional(),
    auth_type: z
      .enum(["none", "header", "query", "bearer", "basic", "oauth2", "aws_sigv4"])
      .optional(),
    template_slug: z.string().min(1).nullable().optional(),
    template_name: z.string().min(1).nullable().optional(),
    template_source: z.enum(["builtin", "tenant"]).nullable().optional(),
    config: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Driver options only (pagination, base_url overrides, static_headers, query_defaults, etc.). The template-derived `config.oauth` block is IMMUTABLE here EXCEPT for the public `client_id` field — write `{ config: { oauth: { client_id } } }` when a template (e.g. cognito_user_password, GitHub App) doesn't seed a default and the operator must supply one. Every other oauth key (token_endpoint, scopes, grant_type, client_secret, ...) is rejected — those are template-owned. For aws_sigv4 connectors, `config.aws_region` and `config.aws_service` are top-level config keys (template-seeded; writeable by the operator only when the template doesn't ship a default). To change auth shape, call `start_connector_from_description` with a different `auth_type`. To run an authorization-code flow on an already-saved oauth2 connector, call `authenticate_oauth`. Never put credentials in `config` (token, password, api_key, client_secret, ...) — collect them via `ask_user_form(sensitive: true)` and pass them through `save_connector_draft({credential})`.",
      ),
    docs: z.array(z.string()).optional(),
  })
  .openapi("UpdateConnectorDraftToolInput");

export const updateConnectorDraftTool: ConversationTool = {
  name: "update_connector_draft",
  description:
    "Update fields on the current connector draft. Use this after each user answer so the operator can inspect the evolving connector before probing or saving. `config` carries driver options only; `config.oauth` and `config.aws_sigv4` are template-owned and rejected here. Credentials never go in `config` — use `ask_user_form` + `save_connector_draft({credential})`.",
  inputSchema,
  category: "draft_write",
  authoring_resource: "connector",
  requires_draft: true,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);

    // The oauth block is owned by template-enrichment (at save time) plus
    // the OAuth2 client snapshot fallback in resolveConnectorOAuthConfig.
    // The LLM cannot rewrite it from scratch — letting that happen creates
    // two writers and reproduces session 18467df2 where bearer drafts
    // ended up carrying oauth metadata that strict-mode then rejected at
    // save. The single carve-out is `config.oauth.client_id`: it's a
    // public id (not a secret), and the cognito_user_password flow needs
    // the operator to provide it when the matched template doesn't seed
    // a default. Every other oauth key is rejected.
    if (args.config !== undefined && Object.hasOwn(args.config, "oauth")) {
      const oauthPatch = (args.config as { oauth?: unknown }).oauth;
      const isClientIdOnlyPatch =
        oauthPatch !== null &&
        typeof oauthPatch === "object" &&
        !Array.isArray(oauthPatch) &&
        Object.keys(oauthPatch as Record<string, unknown>).length === 1 &&
        Object.hasOwn(oauthPatch as Record<string, unknown>, "client_id") &&
        typeof (oauthPatch as { client_id?: unknown }).client_id === "string";
      if (!isClientIdOnlyPatch) {
        // The dead-end depends on whether a template is bound. A
        // template-less oauth2 draft can NEVER carry oauth metadata
        // authored here — the only writers are template enrichment (at
        // save) and the snapshot fallback. Pre-fix the LLM looped this
        // call when no template existed (e.g. LinkedIn before the
        // builtin template landed), burning a turn per retry. Point it
        // at the real path instead of "start a new draft".
        const draft = ctx.getDraft().connector ?? {};
        const hasTemplate = Boolean(draft.template_slug);
        if (draft.auth_type === "oauth2" && !hasTemplate) {
          return {
            ok: false,
            error_code: "oauth_requires_template",
            message:
              "This draft has no connector template, so its OAuth2 metadata (authorization_endpoint, token_endpoint, scopes, grant_type) cannot be authored here — those fields are template-owned. Do NOT retry this call. Pick an existing template with `start_connector_from_template`, or register one for this system via `POST /v1/connector-templates` (admin) and then start from it. Only the public `client_id` is writable on a draft.",
            next_best_actions: ["start_connector_from_template"],
          };
        }
        return {
          ok: false,
          error_code: "auth_mutation_not_allowed",
          message:
            "config.oauth cannot be written via update_connector_draft except for the public field `client_id` — every other oauth key is template-owned. To begin the authorization-code flow on this oauth2 connector, save it first then call `authenticate_oauth`.",
          next_best_actions: ["authenticate_oauth", "save_connector_draft"],
        };
      }
      // Merge the client_id patch into the existing config.oauth so the
      // template-seeded keys (token_endpoint, grant_type, scopes, ...)
      // survive. The patch object is replaced below in the spread; we
      // mutate args.config so the rest of the flow sees the merged shape.
      const draftSoFar = ctx.getDraft().connector ?? {};
      const existingOauth =
        (draftSoFar.config as { oauth?: Record<string, unknown> } | undefined)?.oauth ?? {};
      (args.config as Record<string, unknown>).oauth = {
        ...existingOauth,
        client_id: (oauthPatch as { client_id: string }).client_id,
      };
    }

    if (args.config !== undefined) {
      // Reject the LLM-invented query-auth param-name keys FIRST — before
      // the generic credential-shape guard below. There is NO config slot
      // for the query parameter name: for `auth_type: "query"` the param
      // name lives in the credential's `param` field (collected via
      // ask_user_form + save_connector_draft({credential:{mode:"query",
      // param, value}})). `HttpConnectorConfig` is `.strict()`, so a key
      // like `config.query_param_name` is rejected at save time with the
      // opaque "invalid http connector config" — and the model, given no
      // actionable hint, re-added the key and looped (production session
      // aba4551f, the Browserless connector: the save retried for minutes).
      // This runs ahead of `containsCredentialShape` so keys that also
      // carry a credential substring (`token_param`, `query_key`) get the
      // precise "param belongs in credential.param" message instead of the
      // generic "use a form" one. Generalized, not vendor-specific.
      const authParamKey = findAuthParamConfigKey(args.config);
      if (authParamKey !== null) {
        // Telemetry parity with the credential-shape rejection below:
        // emit the structured log line AND an audit_log row so operator
        // tooling that tails either surface sees the policy decision. The
        // offending KEY name is safe to record; its value never is.
        log.connector.draft.auth_param_in_config({
          conversation_id: ctx.conversation_id,
          tenant_id: ctx.tenant_id,
          matched_key_path: authParamKey,
        });
        recordConnectorDraftCredentialRejected({
          tenant_id: ctx.tenant_id,
          actor_id: ctx.actor_id,
          executor: ctx.db,
          conversation_id: ctx.conversation_id,
          matched_key_path: authParamKey,
          reason: "auth_param_name_in_config",
        });
        return {
          ok: false,
          error_code: "auth_param_name_in_config",
          message:
            `\`config.${authParamKey}\` is not a valid connector config key — there is no config slot for the query parameter name. ` +
            "For query auth the parameter name belongs in the credential's `param` field. " +
            'Set `auth_type: "query"`, then collect the secret via ask_user_form(type: password, sensitive: true) and submit ' +
            'save_connector_draft({credential: {mode: "query", param: "<param-name>", value: "<token>"}}) — e.g. param: "token" for Browserless. ' +
            "Remove this key from config.",
          next_best_actions: ["ask_user_form", "save_connector_draft"],
        };
      }

      // Hard-reject any attempt to store a credential-shaped value in config.
      // The only correct path for credentials is ask_user_form(type: password,
      // sensitive: true) followed by save_connector_draft({credential}).
      const hitPath = containsCredentialShape(args.config, "", 0);
      if (hitPath !== null) {
        log.connector.draft.credential_rejected({
          conversation_id: ctx.conversation_id,
          tenant_id: ctx.tenant_id,
          matched_key_path: hitPath,
          // Value is intentionally NOT logged — only the path is safe to emit.
        });
        // Also land the rejection in the audit log so compliance
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

    // Guard against the LLM reasoning itself in circles by toggling
    // auth_type back to "none" on a connector that already has a
    // credential staged. The user's session bab50df1 looped exactly
    // here: probe failed, the LLM "tried something else" by setting
    // auth_type=none, which made the next probe credential_required,
    // and the cycle repeated. The legitimate path to drop auth is to
    // start a fresh draft, not flip auth_type on an existing one.
    if (
      args.auth_type === "none" &&
      current.auth_type !== undefined &&
      current.auth_type !== null &&
      current.auth_type !== "none"
    ) {
      const cached = getDraftCredential(ctx.conversation_id);
      if (cached || current.saved_connector_id) {
        return {
          ok: false,
          error_code: "auth_type_downgrade_blocked",
          message:
            `Cannot downgrade auth_type from "${current.auth_type}" to "none" — the draft already has a ${cached ? "cached" : "persisted"} credential. ` +
            `Start a new draft via start_connector_from_description if you need a different auth model, or rotate the credential via ask_user_form + save_connector_draft.`,
          next_best_actions: [
            "start_connector_from_description",
            "ask_user_form",
            "save_connector_draft",
          ],
        };
      }
    }

    const patch = Object.fromEntries(
      Object.entries(args).filter(([, value]) => value !== undefined),
    ) as Partial<ConnectorDraftDocument>;
    const next: ConnectorDraftDocument = {
      ...current,
      ...patch,
      config:
        args.config ??
        withMcpAuthKindFollowing(args.auth_type, {
          driver: args.driver ?? current.driver,
          config: current.config,
        }) ??
        current.config ??
        {},
      docs: args.docs ?? current.docs ?? [],
      latest_probe: current.latest_probe ?? null,
      saved_connector_id: current.saved_connector_id ?? null,
    };
    const templates = await listResolvedConnectorTemplates(ctx.db, ctx.tenant_id);
    const validation = validateConnectorDraft(
      next,
      templates.map((entry) => entry.template),
    );
    // An auth edit the draft cannot hold is refused whole: applied, it left a
    // draft that could no longer be probed and — through the cache rule below —
    // threw away the key the operator had typed in. Other findings (a
    // placeholder host, a field still missing) stay on the draft as before.
    const isAuthIssue = (issue: { path: string }) =>
      issue.path === "auth_type" || /^(config\.)?mcp\.auth(\.|$)/.test(issue.path);
    // By path alone: a finding the draft already carried is not new because
    // its wording changed since it was recorded.
    const knownPaths = new Set((current.validation?.errors ?? []).map((issue) => issue.path));
    const introduced = validation.errors.filter(
      (issue) => isAuthIssue(issue) && !knownPaths.has(issue.path),
    );
    if (introduced.length > 0) {
      return {
        ok: false,
        error_code: "invalid_connector_draft_edit",
        message:
          "The edit was not applied — the draft and any key already entered are unchanged. " +
          introduced.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
        data: { errors: introduced },
        next_best_actions: ["update_connector_draft", "inspect_connector_draft"],
      };
    }
    // Cache consistency: switching auth_type invalidates any cached
    // draft credential — it was collected for the OLD auth shape. Pre-fix
    // a bearer token cached before a bearer→basic switch survived and the
    // next probe went out with `Authorization: Bearer …` against a
    // basic-auth endpoint (session 97679846). The downgrade-to-"none"
    // case is already blocked above; this covers mode-to-mode flips.
    let credentialCacheCleared = false;
    if (
      args.auth_type !== undefined &&
      current.auth_type !== undefined &&
      current.auth_type !== null &&
      args.auth_type !== current.auth_type
    ) {
      clearDraftCredential(ctx.conversation_id);
      credentialCacheCleared = true;
    }
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
          ...(credentialCacheCleared ? { credential_cache_cleared: true } : {}),
        },
      }),
    };
  },
};

/**
 * An MCP draft signs in with `config.mcp.auth.kind`, and `auth_type` names the
 * same thing. A switch of `auth_type` alone used to leave the old kind behind,
 * and the edit was refused for a mismatch the caller had not asked for. When
 * `config` is not part of the edit, the kind follows the new `auth_type`; a
 * caller who sends `config` states the kind itself and is validated as sent.
 */
function withMcpAuthKindFollowing(
  auth_type: AuthType | undefined,
  current: { driver: string | undefined; config: Record<string, unknown> | undefined },
): Record<string, unknown> | undefined {
  if (auth_type === undefined || current.driver !== "mcp") return undefined;
  const kind = mcpAuthKindForType(auth_type);
  const config = current.config ?? {};
  const mcp = config.mcp;
  if (!kind || !mcp || typeof mcp !== "object" || Array.isArray(mcp)) return undefined;
  const auth = (mcp as { auth?: unknown }).auth;
  const currentKind =
    auth && typeof auth === "object" ? (auth as { kind?: unknown }).kind : undefined;
  if (typeof currentKind !== "string" || currentKind === kind) return undefined;
  return { ...config, mcp: { ...mcp, auth: { kind } } };
}
