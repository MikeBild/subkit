import { PROVIDER_LIMITED, PROVIDER_QUOTA_EXHAUSTED } from "@shared/error-taxonomy.ts";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { DescriptionAcceptanceError } from "../../api/catalog-metadata.ts";
import { HostedChatOwnershipRequired } from "../../chat/hosted-ownership.ts";
import { connectorConfigIssues } from "../../connectors/config-schemas.ts";
import {
  describeTurnFailure,
  timeoutPhaseOf,
  turnFailureFramePayload,
} from "../../conversations/public/authoring.ts";
import {
  ConversationNotFoundError,
  ConversationTurnInProgressError,
  ElicitationNotFoundError,
  PendingElicitationBlockedError,
} from "../../conversations/types.ts";
import { CatalogVocabularyBusyError } from "../../db/catalog-vocabulary.ts";
import { hostedQuotaError } from "../../db/hosted-quota-errors.ts";
import { HostedFileQuotaError } from "../../files/hosted-quota.ts";
import { ApiKeyOwnerNotFoundError } from "../../identity/api-key-owner.ts";
import { LlmAccessMissing, LlmProviderError, LlmSpendLimitReached } from "../../llm/errors.ts";
import { toLlmProviderError } from "../../llm/provider-errors.ts";
import { isNoObjectGenerated, isProviderCallError } from "../../llm/runtime/sdk-errors.ts";
import { logger } from "../../logging/index.ts";
import type { CapturedError } from "../../observability/error-ring.ts";
import { errorRing } from "../../observability/error-ring.ts";
import { HostedWorkQuotaError } from "../../queue/hosted-work.ts";
import { ScopeExceedsIssuerError, UnknownScopeError } from "../../rbac/scope-issuance.ts";
import { HttpError, UnauthorizedError } from "../errors.ts";
import type { AppEnv } from "../openapi.ts";

interface EnvelopeOptions {
  hint?: string | undefined;
  retry_after?: number | undefined;
  details?: unknown;
}

function envelope(
  c: Context<AppEnv>,
  status: number,
  code: string,
  message: string,
  opts: EnvelopeOptions = {},
) {
  const { hint, details } = opts;
  const retryAfter = opts.retry_after;
  if (retryAfter != null) c.header("Retry-After", String(retryAfter));
  return c.json(
    {
      code,
      message,
      trace_id: c.get("trace_id"),
      ...(hint ? { hint } : {}),
      ...(retryAfter != null ? { retry_after: retryAfter } : {}),
      ...(details ? { details } : {}),
    },
    status as 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502 | 503 | 504,
  );
}

function captureToRing(
  c: Context<AppEnv>,
  err: unknown,
  status: number,
  code: string,
  bucket: CapturedError["bucket"],
): void {
  const principal = c.get("principal") as { tenant_id?: string } | undefined;
  errorRing.record({
    trace_id: c.get("trace_id") ?? null,
    ts: new Date().toISOString(),
    tenant_id: principal?.tenant_id ?? null,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status,
    code,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? (err.stack ?? null) : null,
    bucket,
  });
}

function readRetryAfter(details: unknown): number | undefined {
  if (!details || typeof details !== "object") return undefined;
  const d = details as Record<string, unknown>;
  const raw = d.retry_after ?? d.retryAfter ?? d.retry_after_seconds;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.ceil(raw);
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  }
  return undefined;
}

function mapLlmError(c: Context<AppEnv>, err: unknown): Response | null {
  const quota = hostedQuotaError(err);
  if (quota) return envelope(c, quota.status, quota.code, quota.message);
  if (err instanceof LlmAccessMissing) {
    return envelope(c, 409, err.code, err.message, {
      hint: "open Settings → AI assistant in the Cockpit and enter your provider and API key, then retry",
    });
  }
  if (err instanceof Error && err.name === "ProviderMisconfiguredError") {
    captureToRing(c, err, 400, "llm_provider_misconfigured", "llm_provider");
    return envelope(c, 400, "llm_provider_misconfigured", err.message, {
      hint: "set the provider key with `sk settings set llm.providers.<provider>.api_key '\"…\"'` (or `sk init --llm-api-key`), then retry",
    });
  }
  if (err instanceof HostedChatOwnershipRequired) return envelope(c, 403, err.code, err.message);
  if (err instanceof HostedWorkQuotaError) {
    return envelope(c, 429, err.code, err.message, {
      hint: "Wait for active work to finish or ask the engine operator to review pending and unresolved work",
    });
  }
  if (err instanceof HostedFileQuotaError) {
    return envelope(c, 429, err.code, err.message, {
      hint: "Ask the engine operator to review the file quota; retained files remain charged until verified cleanup succeeds",
    });
  }
  if (err instanceof LlmSpendLimitReached) {
    captureToRing(c, err, 429, "llm_spend_limit_reached", "llm_quota");
    const retryAfter = readRetryAfter(err.details) ?? 60;
    return envelope(c, 429, "llm_spend_limit_reached", err.message, {
      hint: "raise the provider quota or wait for the reset window before retrying",
      retry_after: retryAfter,
      details: err.details,
    });
  }
  const providerErr =
    err instanceof LlmProviderError
      ? err
      : isProviderCallError(err)
        ? toLlmProviderError(err)
        : null;
  if (providerErr) {
    if (providerErr.kind === "context_length_exceeded") {
      captureToRing(c, providerErr, 413, "llm_context_too_large", "llm_provider");
      return envelope(c, 413, "llm_context_too_large", providerErr.message, {
        hint: "compact the conversation with /compact or trim attachments before retrying",
        details: providerErr.details,
      });
    }
    if (providerErr.kind === "rate_limit" || providerErr.kind === "quota_exhausted") {
      const code =
        providerErr.kind === "quota_exhausted" ? PROVIDER_QUOTA_EXHAUSTED : PROVIDER_LIMITED;
      captureToRing(c, providerErr, 429, code, "llm_provider");
      const retryAfter = readRetryAfter(providerErr.details) ?? 30;
      return envelope(c, 429, code, providerErr.message, {
        hint:
          providerErr.kind === "quota_exhausted"
            ? "provider quota exhausted — raise it in the provider console or wait for the next window"
            : "provider rate-limited the request — retry after the cool-down",
        retry_after: retryAfter,
        details: providerErr.details,
      });
    }
    if (providerErr.kind === "overloaded" || providerErr.kind === "other") {
      captureToRing(c, providerErr, 503, "llm_provider_unavailable", "llm_provider");
      return envelope(c, 503, "llm_provider_unavailable", providerErr.message, {
        hint: "the LLM provider is overloaded; retry in a few seconds",
        retry_after: 5,
        details: providerErr.details,
      });
    }
  }
  if (isNoObjectGenerated(err)) {
    captureToRing(c, err, 502, "llm_no_object", "llm_no_object");
    return envelope(c, 502, "llm_no_object", "llm output did not match the expected schema", {
      details: {
        cause: err.cause instanceof Error ? err.cause.message : undefined,
        finishReason: err.finishReason,
        usage: err.usage,
      },
    });
  }
  if (timeoutPhaseOf(err) !== null) {
    const failure = turnFailureFramePayload(describeTurnFailure(err));
    captureToRing(c, err, 504, "llm_timeout", "llm_timeout");
    return envelope(c, 504, "llm_timeout", failure.message, {
      hint: "the model did not answer in time — retry, or shorten the request",
      details: failure.details,
    });
  }
  if (err instanceof Error && err.name === "AbortError") {
    captureToRing(c, err, 504, "llm_timeout", "llm_timeout");
    return envelope(c, 504, "llm_timeout", "llm call exceeded the timeout");
  }
  return null;
}

const CONVERSATION_TURN_ABORT_MESSAGES: Record<string, string> = {
  conversation_turn_superseded: "The conversation turn was superseded by a newer turn.",
  conversation_cancelled: "The conversation turn was cancelled.",
};

export function mapKnownErrorResponse(c: Context<AppEnv>, err: unknown): Response | null {
  let databaseError = err;
  let transactionConflict = false;
  for (let depth = 0; depth < 4 && databaseError instanceof Error; depth++) {
    if (databaseError instanceof CatalogVocabularyBusyError)
      return envelope(
        c,
        409,
        "catalog_vocabulary_changed",
        "Catalog changed concurrently; reload and retry",
      );
    if (
      "code" in databaseError &&
      (databaseError.code === "40001" || databaseError.code === "40P01")
    )
      transactionConflict = true;
    databaseError = databaseError.cause;
  }
  if (transactionConflict)
    return envelope(c, 409, "conflict", "Concurrent operation conflicted; reload and retry");
  if (err instanceof DescriptionAcceptanceError)
    return envelope(c, err.code === "description_changed" ? 409 : 400, err.code, err.message);
  if (err instanceof ApiKeyOwnerNotFoundError) return envelope(c, 404, err.code, err.message);
  if (err instanceof UnknownScopeError)
    return envelope(c, 422, err.code, err.message, { details: { scopes: err.scopes } });
  if (err instanceof ScopeExceedsIssuerError)
    return envelope(c, 403, err.code, err.message, {
      details: { scopes: err.scopes, operator_only: err.operator_only },
    });
  if (err instanceof HTTPException && err.status === 415)
    return envelope(c, 415, "unsupported_media_type", "Unsupported request Content-Type");
  if (err instanceof HTTPException && err.status === 400)
    return envelope(
      c,
      400,
      /malformed json/i.test(err.message) ? "malformed_json" : "bad_request",
      err.message || "Bad request",
    );
  if (err instanceof ConversationTurnInProgressError)
    return envelope(c, 409, err.code, err.message);
  if (err instanceof PendingElicitationBlockedError)
    return envelope(c, 409, err.code, err.message, {
      details: {
        conversation_status: "awaiting_input",
        pending_elicitation: err.pending_elicitation,
      },
    });
  if (typeof err === "string" && Object.hasOwn(CONVERSATION_TURN_ABORT_MESSAGES, err))
    return envelope(c, 409, err, CONVERSATION_TURN_ABORT_MESSAGES[err] ?? err);
  if (err instanceof ElicitationNotFoundError || err instanceof ConversationNotFoundError)
    return envelope(c, 404, "not_found", "Conversation or question not found.");
  const configIssues = connectorConfigIssues(err);
  if (configIssues)
    return envelope(
      c,
      400,
      "connector_config_invalid",
      [(err as Error).message, ...configIssues.slice(0, 5)].join(" — "),
      { details: { issues: configIssues } },
    );
  if (err instanceof HttpError) {
    if (err.status >= 500) captureToRing(c, err, err.status, err.code, "http");
    if (err instanceof UnauthorizedError && err.wwwAuthenticate) {
      c.header("WWW-Authenticate", err.wwwAuthenticate);
    }
    return envelope(c, err.status, err.code, err.message, {
      hint: err.hint,
      retry_after: err.retry_after,
      details: err.details,
    });
  }
  return mapLlmError(c, err);
}

export function errorMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    try {
      await next();
    } catch (err) {
      const knownResponse = mapKnownErrorResponse(c, err);
      if (knownResponse) return knownResponse;
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ msg: "unhandled error", error: message, trace_id: c.get("trace_id") });
      captureToRing(c, err, 500, "internal_error", "unhandled");
      return envelope(c, 500, "internal_error", "internal error");
    }
    return undefined;
  };
}
