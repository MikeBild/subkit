import { z } from "@hono/zod-openapi";
import { recordConnectorDraftCredentialRejected } from "../../audit/recorders/index.ts";
import { mcpAuthKindForType } from "../../connectors/config-schemas.ts";
import { listResolvedConnectorTemplates } from "../../connectors/template-resolver.ts";
import { type AuthType, DriverEnum } from "../../connectors/types.ts";
import { log } from "../../logging/index.ts";
import { SECRET_PATTERNS, SENSITIVE_KEY_PATTERN } from "../../logging/scrub-secrets.ts";
import { withConnectorDraft } from "../authoring-state/index.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { confirmationFieldIn, isStdioConfig } from "../local-command.ts";
import { clearDraftCredential, getDraftCredential } from "../persistence/draft-credential-cache.ts";
import type { ConnectorDraftDocument } from "../types.ts";
import { auditActorFromToolContext } from "./audit-actor.ts";
import { buildDraftMutationPayload } from "./authoring-contract.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const CREDENTIAL_KEY_RE =
  /^(token|api[_-]?key|password|credential|secret|.*_token|authorization|access[_-]?token|client[_-]?secret|private[_-]?key)$/i;

const NON_SECRET_KEYS = new Set<string>([
  "token_endpoint",
  "authorization_endpoint",
  "token_url",
  "authorization_url",
  "issuer_url",
  "token_auth_method",
  "token_content_type",
  "env_secret_names",
]);

function containsCredentialShape(value: unknown, path: string, depth: number): string | null {
  if (depth > 12) return null;
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
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
    if (!NON_SECRET_KEYS.has(key.toLowerCase())) {
      if (SENSITIVE_KEY_PATTERN.test(key) || CREDENTIAL_KEY_RE.test(key)) {
        return childPath;
      }
    }
    const hit = containsCredentialShape(child, childPath, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

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
      .enum(["none", "header", "query", "bearer", "basic", "oauth2", "aws_sigv4", "signed_jwt"])
      .optional(),
    template_slug: z.string().min(1).nullable().optional(),
    template_name: z.string().min(1).nullable().optional(),
    template_source: z.enum(["builtin", "tenant"]).nullable().optional(),
    config: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Public signed_jwt settings belong in config.signed_jwt (algorithm, audience, issuer, subject, key_id, claims, ttl_seconds); never put private_key there. Driver options only (pagination, base_url overrides, static_headers, query_defaults, etc.). The template-derived `config.oauth` block is IMMUTABLE here EXCEPT for the public `client_id` field — write `{ config: { oauth: { client_id } } }` when a template (e.g. cognito_user_password, GitHub App) doesn't seed a default and the operator must supply one. Every other oauth key (token_endpoint, scopes, grant_type, client_secret, ...) is rejected — those are template-owned. For aws_sigv4 connectors, `config.aws_region` and `config.aws_service` are top-level config keys (template-seeded; writeable by the operator only when the template doesn't ship a default). To change auth shape, call `start_connector_from_description` with a different `auth_type`. To run an authorization-code flow on an already-saved oauth2 connector, call `authenticate_oauth`. Never put credentials in `config` (token, password, api_key, client_secret, ...) — collect them via `ask_user_form(sensitive: true)` and pass them through `save_connector_draft({credential})`.",
      ),
    docs: z.array(z.string()).optional(),
    transport: z
      .enum(["http", "sse", "stdio"])
      .optional()
      .describe(
        "MCP only. http or sse need base_url; stdio starts a local command (command, args, env, env_secret_names, cwd) and has no base_url. A person must allow the command before the first probe and again after every change.",
      ),
    command: z
      .string()
      .min(1)
      .optional()
      .describe(
        "MCP stdio only: the program to start, absolute or found on PATH, e.g. docker or npx. Never a shell line.",
      ),
    args: z.array(z.string()).optional().describe("MCP stdio only: the program arguments."),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "MCP stdio only: non-secret environment variables. Secret values never go here: list their names in env_secret_names.",
      ),
    env_secret_names: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "MCP stdio only: names of secret environment variables; the values are collected through the credential form.",
      ),
    cwd: z.string().min(1).optional().describe("MCP stdio only: the working folder."),
    tls: z
      .object({ ca_pem: z.string().optional(), skip_verify: z.boolean().optional() })
      .optional()
      .describe(
        "Local https targets only (localhost, 127.0.0.1, [::1], host.docker.internal): a PEM CA certificate, or skip_verify to accept any certificate. Ignored for remote hosts.",
      ),
  })
  .openapi("UpdateConnectorDraftToolInput");

const LOCAL_FIELD_KEYS = [
  "transport",
  "command",
  "args",
  "env",
  "env_secret_names",
  "cwd",
  "tls",
] as const;

type LocalFieldArgs = Pick<z.infer<typeof inputSchema>, (typeof LOCAL_FIELD_KEYS)[number]>;

function hasLocalFields(args: LocalFieldArgs): boolean {
  return LOCAL_FIELD_KEYS.some((key) => args[key] !== undefined);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function mergeLocalFields(
  driver: string | undefined,
  config: Record<string, unknown>,
  args: LocalFieldArgs,
): Record<string, unknown> {
  if (driver !== "mcp") {
    return args.tls === undefined ? config : { ...config, tls: args.tls };
  }
  const mcp = { ...asObject(config.mcp) };
  if (args.transport !== undefined) mcp.transport = args.transport;
  if (args.command !== undefined) mcp.command = args.command;
  if (args.args !== undefined) mcp.args = args.args;
  if (args.env !== undefined) mcp.env = args.env;
  if (args.env_secret_names !== undefined) mcp.env_secret_names = args.env_secret_names;
  if (args.cwd !== undefined) mcp.cwd = args.cwd;
  if (args.tls !== undefined) mcp.tls = args.tls;
  if (mcp.transport === "stdio") delete mcp.tls;
  return { ...config, mcp };
}

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
      const draftSoFar = ctx.getDraft().connector ?? {};
      const existingOauth =
        (draftSoFar.config as { oauth?: Record<string, unknown> } | undefined)?.oauth ?? {};
      (args.config as Record<string, unknown>).oauth = {
        ...existingOauth,
        client_id: (oauthPatch as { client_id: string }).client_id,
      };
    }

    const confirmationKey = confirmationFieldIn(args.config);
    if (confirmationKey !== null) {
      return {
        ok: false,
        error_code: "local_command_confirmation_not_writable",
        message: `\`config.${confirmationKey}\` is set by the engine when a person allows the local command. It cannot be written here. Probe the draft: SubKit then asks the person to allow the command.`,
        next_best_actions: ["probe_connector_draft"],
      };
    }

    if (args.config !== undefined) {
      const authParamKey = findAuthParamConfigKey(args.config);
      if (authParamKey !== null) {
        log.connector.draft.auth_param_in_config({
          conversation_id: ctx.conversation_id,
          tenant_id: ctx.tenant_id,
          matched_key_path: authParamKey,
        });
        recordConnectorDraftCredentialRejected({
          tenant_id: ctx.tenant_id,
          ...auditActorFromToolContext(ctx),
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

      const hitPath = containsCredentialShape(args.config, "", 0);
      if (hitPath !== null) {
        log.connector.draft.credential_rejected({
          conversation_id: ctx.conversation_id,
          tenant_id: ctx.tenant_id,
          matched_key_path: hitPath,
        });
        recordConnectorDraftCredentialRejected({
          tenant_id: ctx.tenant_id,
          ...auditActorFromToolContext(ctx),
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

    if (args.env !== undefined) {
      const envHit = containsCredentialShape({ env: args.env }, "mcp", 0);
      if (envHit !== null) {
        return {
          ok: false,
          error_code: "credential_must_use_form",
          message: `\`${envHit}\` looks like a secret. Secret environment variables never go into env: list the variable name in env_secret_names, collect the value with ask_user_form(type: password, sensitive: true), then save_connector_draft({credential}).`,
          next_best_actions: ["update_connector_draft", "ask_user_form"],
        };
      }
    }

    const current = ctx.getDraft().connector ?? {};

    if (
      args.auth_type === "none" &&
      current.auth_type !== undefined &&
      current.auth_type !== null &&
      current.auth_type !== "none"
    ) {
      const cached = getDraftCredential(ctx.conversation_id);
      const probeWasGreen = current.latest_probe?.ok === true;
      const persistedWithUnknownProbe =
        Boolean(current.saved_connector_id) && current.latest_probe == null;
      if ((cached || current.saved_connector_id) && (probeWasGreen || persistedWithUnknownProbe)) {
        return {
          ok: false,
          error_code: "auth_type_downgrade_blocked",
          message:
            `Cannot downgrade auth_type from "${current.auth_type}" to "none" — the draft already has a ${cached ? "cached" : "persisted"} credential that ${probeWasGreen ? "passed a probe" : "belongs to the saved connector"}. ` +
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
      Object.entries(args).filter(
        ([key, value]) =>
          value !== undefined && !(LOCAL_FIELD_KEYS as readonly string[]).includes(key),
      ),
    ) as Partial<ConnectorDraftDocument>;
    const nextDriver = args.driver ?? current.driver;
    const baseConfig =
      args.config ??
      withMcpAuthKindFollowing(args.auth_type, {
        driver: nextDriver,
        config: current.config,
      }) ??
      current.config ??
      {};
    const nextConfig = hasLocalFields(args)
      ? mergeLocalFields(nextDriver, baseConfig, args)
      : baseConfig;
    const becomesStdio = isStdioConfig(nextConfig);
    const next: ConnectorDraftDocument = {
      ...current,
      ...patch,
      config: nextConfig,
      docs: args.docs ?? current.docs ?? [],
      latest_probe: current.latest_probe ?? null,
      saved_connector_id: current.saved_connector_id ?? null,
    };
    if (becomesStdio && args.base_url === undefined) delete next.base_url;
    const secretEnvNames = (nextConfig.mcp as { env_secret_names?: unknown } | undefined)
      ?.env_secret_names;
    if (
      becomesStdio &&
      Array.isArray(secretEnvNames) &&
      secretEnvNames.length > 0 &&
      (next.auth_type ?? "none") === "none"
    ) {
      next.auth_type = "header";
      next.config = {
        ...nextConfig,
        mcp: { ...(nextConfig.mcp as Record<string, unknown>), auth: { kind: "header" } },
      };
    }
    const templates = await listResolvedConnectorTemplates(ctx.db, ctx.tenant_id);
    const validation = validateConnectorDraft(
      next,
      templates.map((entry) => entry.template),
    );
    const isAuthIssue = (issue: { path: string }) =>
      issue.path === "auth_type" || /^(config\.)?mcp\.auth(\.|$)/.test(issue.path);
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
