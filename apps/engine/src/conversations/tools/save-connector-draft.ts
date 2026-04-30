// save_connector_draft — diagnostic re-issue path.
//
// The normal commit happens in the harness auto-persist on
// `ask_user_form` submit (one transactional connector + credential
// write driven by `elicitations.ts` → `saveConnectorAtomic` with
// `reason: "auto_persist_on_confirmation"`). This tool stays
// available for legitimate re-issue cases:
//   - rotating the credential after an initial save,
//   - recovering from a half-applied write,
//   - persisting after a probe failed by passing `force_save: true`.
//
// The audit row emitted from this tool path carries
// `reason: "manual_re_issue"`. The harness auto-persist path emits
// `reason: "auto_persist_on_confirmation"`. That distinction lets
// operators tell the two writes apart in the audit trail when
// triaging a "why are there two writes against the same connector"
// question.

import { z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import {
  recordConnectorCreated,
  recordConnectorSavedOverride,
  recordConnectorUpdated,
} from "../../audit/recorders/index.ts";
import { getConnector } from "../../connectors/service.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import { conversations } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { translateAutoPersistError } from "../persistence/auto-persist.ts";
import { type AtomicCredentialInput, saveConnectorAtomic } from "../persistence/save-connector.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

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
// Cognito User-Password bootstrap. `region` and `client_id` may be
// omitted when the connector config already carries them
// (config.aws_region + config.oauth.client_id) — saveConnectorAtomic
// will fall back to those slots before calling InitiateAuth.
const cognitoCredentialInput = z.object({
  mode: z.literal("cognito_user_password"),
  username: z.string().min(1),
  password: z.string().min(1),
  aws_region: z.string().min(1).optional(),
  client_id: z.string().min(1).optional(),
  client_secret: z.string().min(1).optional(),
  use_access_token: z.boolean().optional(),
});
// AWS SigV4 — for diagnostic re-issue against AppSync IAM, DynamoDB,
// API Gateway IAM, etc. The auto-persist path covers the normal
// flow; this slot keeps the tool symmetric.
const awsSigV4CredentialInput = z.object({
  mode: z.literal("aws_sigv4"),
  access_key_id: z.string().min(1),
  secret_access_key: z.string().min(1),
  session_token: z.string().min(1).optional(),
});

const credentialInput = z
  .discriminatedUnion("mode", [
    bearerCredentialInput,
    basicCredentialInput,
    headerCredentialInput,
    queryCredentialInput,
    cognitoCredentialInput,
    awsSigV4CredentialInput,
  ])
  .describe(
    "Optional credential to (re-)attach. Sourced verbatim from a masked `ask_user_form(type: password, sensitive: true)` submission — never typed in chat. `cognito_user_password` triggers an InitiateAuth exchange before persisting; the row ends up as a regular oauth2 credential with refresh_token + expires_at.",
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

    const draft = ctx.getDraft();
    const connector = draft.connector;
    const supplied: Credential | undefined = args.credential;

    // Idempotency: if the auto-persist already applied the same write,
    // this re-issue must be a no-op. Look up the saved connector (if
    // any) and compare the supplied credential's identifying shape
    // against the stored credential. A match short-circuits with
    // `already_persisted: true` and never touches the DB.
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
        if (credentialMatches) {
          logger.info({
            module: "conversation_tool",
            action: "save_connector_draft.already_persisted",
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            connector_id: existing.id,
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
              next_best_actions: ["inspect_connector", "list_connectors"],
            },
          };
        }
        // Operator is rotating the credential. Forward the new value
        // through `saveConnectorAtomic` (which short-circuits on
        // `saved_connector_id` and runs `upsertCredential` against the
        // already-saved row), then emit the `manual_re_issue` audit
        // entry that distinguishes this from auto_persist_on_confirmation.
        const result = await saveConnectorAtomic({
          ctx,
          environment: args.environment,
          forceSave: args.force_save,
          reason: "manual_re_issue",
          ...(supplied ? { credential: supplied as AtomicCredentialInput } : {}),
        });
        await recordConnectorUpdated({
          tenant_id: ctx.tenant_id,
          actor_id: ctx.actor_id,
          executor: ctx.db,
          connector_id: existing.id,
          kind: "credential_rotated",
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
          kind: "credential_rotated",
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

    // First-save path on this draft. The atomic helper enforces the
    // probe gate (and surfaces a `probe_failed` envelope when force_save
    // is false). We track `probeFailed` here so we can attach the
    // `manual_re_issue` audit row + warning on the way out.
    const requiresProbe =
      connector?.driver === "http" ||
      connector?.driver === "graphql" ||
      connector?.driver === "postgres" ||
      connector?.driver === "s3";
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
      // Translate Postgres errors (23505 unique_violation, 23503 fk
      // violation, 23502 not-null, 22P02 invalid uuid/enum) into the
      // same typed error_codes the auto-persist path uses.
      // Pre-fix (session 975a64b0 16:37:21) the raw `Failed query:
      // insert into "connectors" ...` SQL was passed verbatim to the
      // LLM, which then spent 90s of "summarising 5 tool results"
      // trying to make sense of it. Post-fix the LLM gets
      // `slug_already_in_use` + `next_best_actions: [list_connectors,
      // get_connector, update_connector]` and can recover in one turn.
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
      // probe_failed / connector_not_ready etc — the helper already
      // populated next_best_actions and force_save_available.
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

    // Resolve the new connector id from the result envelope, falling
    // back to the conversation row that saveConnectorAtomic just
    // refreshed. Without an id we'd skip the audit row, which would
    // make this re-issue indistinguishable from the auto-persist path.
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
      const rows = await ctx.db
        .select({ id: conversations.target_connector_id })
        .from(conversations)
        .where(eq(conversations.id, ctx.conversation_id))
        .limit(1);
      connector_id = rows[0]?.id ?? null;
    }
    if (connector_id) {
      // The atomic helper already emits a `CONNECTOR_SAVED_OVERRIDE`
      // audit row (with our `reason: "manual_re_issue"`) when force_save
      // overrode a failed probe. We add a second `manual_re_issue` row
      // tagged `tool: save_connector_draft` so non-override saves are
      // still distinguishable from the harness auto-persist path.
      if (probeFailed) {
        await recordConnectorSavedOverride({
          tenant_id: ctx.tenant_id,
          actor_id: ctx.actor_id,
          executor: ctx.db,
          connector_id,
          slug: connector?.slug ?? "",
          driver: connector?.driver ?? "",
          environment: args.environment,
          reason: "manual_re_issue",
          source: "tool_call",
          tool: "save_connector_draft",
          // Tool-side row is tagged `probe_override` so operators can
          // tell the two override audits apart (the atomic helper's
          // row is tagged `force_save_override`).
          kind: "probe_override",
          latest_probe: connector?.latest_probe ?? null,
          probe_failure_code: connector?.latest_probe?.failure_code ?? null,
        });
      } else {
        await recordConnectorCreated({
          tenant_id: ctx.tenant_id,
          actor_id: ctx.actor_id,
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

/**
 * Idempotency check for the diagnostic re-issue path. Returns true
 * when no write is needed:
 *   - no credential supplied (operator is just confirming the
 *     connector row is in place), OR
 *   - the existing credential row matches the supplied one
 *     byte-for-byte in its identifying shape (token, username +
 *     password, header name + value, query param + value).
 *
 * Returns false when a real rotation is happening — the caller forwards
 * the credential to `saveConnectorAtomic` so it lands.
 */
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
  // Cognito bootstrap persists as `mode: "oauth2"` (post-exchange). The
  // idempotency check can't compare passwords against an opaque JWT, so
  // we treat any pre-existing oauth2 row as "already credentialed" — a
  // re-issue with the same username + password is a no-op from the
  // operator's perspective. Operators rotating creds should call the
  // tool with a different password (which still re-runs InitiateAuth via
  // saveConnectorAtomic since that path always re-exchanges).
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
  if (supplied.mode === "aws_sigv4" && stored.mode === "aws_sigv4") {
    return (
      stored.access_key_id === supplied.access_key_id &&
      stored.secret_access_key === supplied.secret_access_key &&
      (stored.session_token ?? null) === (supplied.session_token ?? null)
    );
  }
  return false;
}
