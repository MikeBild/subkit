import { z } from "@hono/zod-openapi";
import {
  recordConnectorCreated,
  recordConnectorSavedOverride,
  recordConnectorUpdated,
} from "../../audit/recorders/index.ts";
import { getConnector } from "../../connectors/service.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import { safeParseJson } from "../../llm/runtime/safe-json.ts";
import { logger } from "../../logging/logger.ts";
import { translateAutoPersistError } from "../persistence/auto-persist/index.ts";
import {
  type AtomicCredentialInput,
  connectorFieldPatch,
  saveConnectorAtomic,
} from "../persistence/save-connector.ts";
import { readConversationTargets } from "../service/tool-state.ts";
import { auditActorFromToolContext } from "./audit-actor.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { buildConnectorUsage } from "./usage-guidance.ts";

const bearerCredentialInput = z.object({
  mode: z.literal("bearer"),
  token: z.string().min(1),
});
const basicCredentialInput = z.object({
  mode: z.literal("basic"),
  username: z.string().min(1),
  password: z.string().min(1),
});
const headerCredentialInput = z.object({
  mode: z.literal("header"),
  header_name: z.string().min(1),
  header_value: z.string().min(1),
});
const queryCredentialInput = z.object({
  mode: z.literal("query"),
  param: z.string().min(1),
  value: z.string().min(1),
});
const cognitoCredentialInput = z.object({
  mode: z.literal("cognito_user_password"),
  username: z.string().min(1),
  password: z.string().min(1),
  aws_region: z.string().min(1).optional(),
  client_id: z.string().min(1).optional(),
  client_secret: z.string().min(1).optional(),
  use_access_token: z.boolean().optional(),
});
const awsSigV4CredentialInput = z.object({
  mode: z.literal("aws_sigv4"),
  access_key_id: z.string().min(1),
  secret_access_key: z.string().min(1),
  session_token: z.string().min(1).optional(),
});
const oauth2CredentialInput = z.object({
  mode: z.literal("oauth2"),
  client_id: z.string().min(1),
  client_secret: z.string().min(1).optional(),
  token_endpoint: z.string().url().optional(),
  authorization_endpoint: z.string().url().optional(),
  scopes: z.string().optional(),
});

const credentialUnion = z.discriminatedUnion("mode", [
  bearerCredentialInput,
  z.object({ mode: z.literal("signed_jwt"), private_key: z.string().min(1).max(16384) }),
  basicCredentialInput,
  headerCredentialInput,
  queryCredentialInput,
  cognitoCredentialInput,
  awsSigV4CredentialInput,
  oauth2CredentialInput,
]);

const credentialInput = z
  .preprocess((raw) => {
    if (typeof raw !== "string") return raw;
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) return raw;
    const parsed = safeParseJson(trimmed);
    return parsed && typeof parsed === "object" ? parsed : raw;
  }, credentialUnion)
  .describe(
    "Optional credential to (re-)attach. Sourced verbatim from a masked `ask_user_form(type: password, sensitive: true)` submission — never typed in chat. `cognito_user_password` triggers an InitiateAuth exchange before persisting; the row ends up as a regular oauth2 credential with refresh_token + expires_at. `oauth2` carries the operator's client_id (+ optional client_secret + endpoints) into `config.oauth` so the subsequent `authenticate_oauth` call can run the dance — no credential row is written until the OAuth callback completes.",
  );

const inputSchema = z
  .object({
    credential: credentialInput.optional(),
    environment: z.enum(["dev", "prod"]).default("dev"),
    force_save: z
      .boolean()
      .default(false)
      .describe(
        "Persist the draft even if the most recent probe failed. Surfaces a warning in the response and tags the audit row with `kind: probe_override`. Use only when the operator explicitly confirms.",
      ),
  })
  .openapi("SaveConnectorDraftToolInput");

type Credential = z.infer<typeof credentialInput>;

export const saveConnectorDraftTool: ConversationTool = {
  name: "save_connector_draft",
  description:
    "Diagnostic re-issue: persist the draft atomically with an optionally-rotated credential. The normal commit path is the harness auto-persist on `ask_user_form` submit — only call this tool when the operator wants to re-save (rotate credential, recover from a partial write, or save with `force_save: true` after a failed probe).",
  inputSchema,
  category: "tenant_write",
  authoring_resource: "connector",
  requires_draft: true,
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    logger.info({
      module: "conversation_tool",
      action: "save_connector_draft.started",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      has_credential: Boolean(args.credential),
      force_save: args.force_save === true,
    });

    if (args.credential) {
      const leakedField = findMustachePlaceholderField(args.credential);
      if (leakedField) {
        return {
          ok: false,
          error_code: "credential_placeholder_leak",
          message: `credential.${leakedField} is a Mustache placeholder ("{{...}}") rather than a real value — secrets must be collected via ask_user_form(type: password, sensitive: true) and submitted by the operator, not authored by the LLM`,
          next_best_actions: ["ask_user_form"],
          data: {
            error_code: "credential_placeholder_leak",
            field: leakedField,
          },
        };
      }
    }

    const draft = ctx.getDraft();
    const connector = draft.connector;
    const supplied: Credential | undefined = args.credential;

    const existingSavedId = connector?.saved_connector_id ?? null;
    if (existingSavedId) {
      const existing = await getConnector(ctx.tenant_id, existingSavedId, ctx.db);
      if (existing) {
        const credentialMatches = await existingCredentialMatches({
          tenant_id: ctx.tenant_id,
          connector_id: existing.id,
          environment: args.environment,
          supplied,
          db: ctx.db as Db,
        });
        const fieldPatch = connectorFieldPatch(connector, existing);
        const fieldsChanged = Object.keys(fieldPatch).length > 0;
        if (credentialMatches && !fieldsChanged) {
          logger.info({
            module: "conversation_tool",
            action: "save_connector_draft.already_persisted",
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            connector_id: existing.id,
          });
          const usage = buildConnectorUsage({
            id: existing.id,
            slug: existing.slug,
            display_name: existing.display_name,
            environment: existing.environment,
            driver: existing.driver,
          });
          return {
            ok: true,
            data: {
              already_persisted: true,
              connector_id: existing.id,
              connector: {
                id: existing.id,
                slug: existing.slug,
                display_name: existing.display_name,
                environment: existing.environment,
                driver: existing.driver,
              },
              usage,
              next_best_actions: ["inspect_connector", "list_connectors"],
              next_prompt: usage.follow_up,
            },
          };
        }
        const reissueKind = !credentialMatches ? "credential_rotated" : "field_edit";
        const result = await saveConnectorAtomic({
          ctx,
          environment: args.environment,
          forceSave: args.force_save,
          reason: "manual_re_issue",
          ...(supplied ? { credential: supplied as AtomicCredentialInput } : {}),
        });
        await recordConnectorUpdated({
          tenant_id: ctx.tenant_id,
          ...auditActorFromToolContext(ctx),
          executor: ctx.db,
          connector_id: existing.id,
          kind: reissueKind,
          reason: "manual_re_issue",
          source: "tool_call",
          tool: "save_connector_draft",
          environment: args.environment,
          ...(supplied ? { credential_mode: supplied.mode } : {}),
        });
        logger.info({
          module: "conversation_tool",
          action: "save_connector_draft.re_issued",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          connector_id: existing.id,
          kind: reissueKind,
          ...(fieldsChanged ? { fields_updated: Object.keys(fieldPatch) } : {}),
        });
        if (result.ok) {
          const data =
            typeof result.data === "object" && result.data !== null
              ? (result.data as Record<string, unknown>)
              : {};
          return {
            ok: true,
            data: {
              ...data,
              re_issued: true,
              audit_reason: "manual_re_issue",
            },
          };
        }
        return result;
      }
    }

    const requiresProbe =
      connector?.auth_type !== "oauth2" &&
      (connector?.driver === "http" ||
        connector?.driver === "graphql" ||
        connector?.driver === "postgres" ||
        connector?.driver === "s3");
    const probeFailed = Boolean(connector) && requiresProbe && connector?.latest_probe?.ok !== true;

    let atomicResult: ToolResult;
    try {
      atomicResult = await saveConnectorAtomic({
        ctx,
        environment: args.environment,
        forceSave: args.force_save,
        reason: "manual_re_issue",
        ...(supplied ? { credential: supplied as AtomicCredentialInput } : {}),
      });
    } catch (err) {
      const translated = translateAutoPersistError(err, "save_connector_draft");
      logger.warn({
        module: "conversation_tool",
        action: "save_connector_draft.atomic_threw",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        error_code: translated.error_code,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        data: {
          error_code: translated.error_code,
          message: translated.message,
          next_best_actions: translated.next_best_actions,
        },
      };
    }
    if (!atomicResult.ok) {
      if (atomicResult.error_code === "probe_failed") {
        logger.info({
          module: "conversation_tool",
          action: "save_connector_draft.probe_failed",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          failure_code: connector?.latest_probe?.failure_code ?? null,
        });
      }
      return atomicResult;
    }

    const data =
      typeof atomicResult.data === "object" && atomicResult.data !== null
        ? (atomicResult.data as Record<string, unknown>)
        : {};
    const dataConnector =
      data.connector && typeof data.connector === "object"
        ? (data.connector as { id?: unknown })
        : null;
    let connector_id = typeof dataConnector?.id === "string" ? dataConnector.id : null;
    if (!connector_id) {
      const targets = await readConversationTargets(ctx.db, {
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
      });
      connector_id = targets?.target_connector_id ?? null;
    }
    if (connector_id) {
      if (probeFailed) {
        await recordConnectorSavedOverride({
          tenant_id: ctx.tenant_id,
          ...auditActorFromToolContext(ctx),
          executor: ctx.db,
          connector_id,
          slug: connector?.slug ?? "",
          driver: connector?.driver ?? "",
          environment: args.environment,
          reason: "manual_re_issue",
          source: "tool_call",
          tool: "save_connector_draft",
          kind: "probe_override",
          latest_probe: connector?.latest_probe ?? null,
          probe_failure_code: connector?.latest_probe?.failure_code ?? null,
        });
      } else {
        await recordConnectorCreated({
          tenant_id: ctx.tenant_id,
          ...auditActorFromToolContext(ctx),
          executor: ctx.db,
          connector_id,
          slug: connector?.slug ?? "",
          driver: connector?.driver ?? "",
          environment: args.environment,
          reason: "manual_re_issue",
          source: "tool_call",
          ...(supplied ? { credential_persisted: true } : {}),
        });
      }
    }
    logger.info({
      module: "conversation_tool",
      action: "save_connector_draft.re_issued",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      connector_id,
      kind: probeFailed ? "probe_override" : "create_via_tool",
    });
    const warnings: string[] = [];
    if (probeFailed) {
      warnings.push(
        `force_save: connector persisted with a failed probe (${connector?.latest_probe?.failure_code ?? "unknown"}). Audit reason: manual_re_issue, kind: probe_override.`,
      );
    }
    return {
      ok: true,
      data: {
        ...data,
        re_issued: true,
        audit_reason: "manual_re_issue",
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    };
  },
};

async function existingCredentialMatches(p: {
  tenant_id: string;
  connector_id: string;
  environment: "dev" | "prod";
  supplied: Credential | undefined;
  db: Db;
}): Promise<boolean> {
  if (!p.supplied) return true;
  const existing = await getCredentialForConnector(
    p.tenant_id,
    p.connector_id,
    p.environment,
    p.db,
  );
  if (!existing) return false;
  const supplied = p.supplied;
  const stored = existing.value as { mode: string } & Record<string, unknown>;
  if (supplied.mode === "cognito_user_password" && stored.mode === "oauth2") {
    return true;
  }
  if (existing.value.mode !== supplied.mode) return false;
  if (supplied.mode === "bearer" && stored.mode === "bearer") {
    return stored.token === supplied.token;
  }
  if (supplied.mode === "basic" && stored.mode === "basic") {
    return stored.username === supplied.username && stored.password === supplied.password;
  }
  if (supplied.mode === "header" && stored.mode === "header") {
    const headers = (stored.headers as Record<string, string> | undefined) ?? {};
    return headers[supplied.header_name] === supplied.header_value;
  }
  if (supplied.mode === "query" && stored.mode === "query") {
    const query = (stored.query as Record<string, string> | undefined) ?? {};
    return query[supplied.param] === supplied.value;
  }
  if (supplied.mode === "signed_jwt" && stored.mode === "signed_jwt") {
    return supplied.private_key === stored.private_key;
  }
  if (supplied.mode === "aws_sigv4" && stored.mode === "aws_sigv4") {
    return (
      stored.access_key_id === supplied.access_key_id &&
      stored.secret_access_key === supplied.secret_access_key &&
      (stored.session_token ?? null) === (supplied.session_token ?? null)
    );
  }
  if (supplied.mode === "oauth2") return false;
  return false;
}

const MUSTACHE_PLACEHOLDER_RE = /^\{\{[^}]+\}\}$/;

function findMustachePlaceholderField(credential: Credential): string | null {
  for (const [k, v] of Object.entries(credential)) {
    if (typeof v === "string" && MUSTACHE_PLACEHOLDER_RE.test(v)) return k;
  }
  return null;
}
