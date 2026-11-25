import { redactKnownValues } from "@shared/redaction.ts";
import { persistCircuitState } from "../../../connectors/circuit-breaker.ts";
import { serializeXmlBody } from "../../../connectors/drivers/http.ts";
import {
  connectorlessProtocol,
  lookupDriver,
  requestDriverKind,
} from "../../../connectors/drivers/port.ts";
import { getConnectorForEnvironment, isCircuitOpenBlocking } from "../../../connectors/service.ts";
import type { CredentialUseSnapshot } from "../../../credentials/index.ts";
import {
  prepareStepVault,
  type ResolvedAuthorityReference,
  resolvePlaceholders,
  resolvePlaceholdersTypePreserving,
  resolveStringPlaceholders,
} from "../../../llm/substitution/resolver.ts";
import { logger } from "../../../logging/index.ts";
import { getMetrics, METRIC_NAMES } from "../../../observability/metrics.ts";
import { authorityConnectorDigest } from "../../../workflows/authority-configuration.ts";
import { outboxSourceFacts } from "../../../workflows/outbox-delivery-boundary.ts";
import { combineSignals } from "../../abort.ts";
import { SYSTEM_CLOCK } from "../../clock.ts";
import { connectorStepRefusal } from "../../connector-availability.ts";
import { appendCredentialSnapshot } from "../../credential-snapshots.ts";
import { resolveScopeForJsonata } from "../../jsonata-bindings.ts";
import type { MaterializedRequest } from "../../prepared-request.ts";
import { applyResponseFilters, ResponseFilterFailError } from "../../response-filter.ts";
import { isConfirmedTransactionalMail, settleTransactionalMail } from "../../transactional-mail.ts";
import type { RequestMeta, StepResult } from "../../types.ts";
import { buildStepErrorDetail } from "../error-detail.ts";
import {
  type CredentialSnapshot,
  type DispatchState,
  failedStep,
  type RequestConnector,
  type RequestDispatch,
  type RequestStepDriver,
  type ResolvedRequestParts,
  type RunRequestStepParams,
  setupFailure,
} from "./drivers/context.ts";
import { DRIVERS } from "./drivers/registry.ts";
import { RequestError } from "./errors.ts";
import { resolveRequestQuery } from "./query-params.ts";
import { rateLimitDeadline } from "./rate-limit.ts";
import { isDocumentedReadOperation } from "./read-operations.ts";
import { requestMaxAttempts } from "./retry.ts";
import { deriveAuthMethodFromAuthType } from "./shape.ts";
import { classifyRequestStepSideEffects, requestRequiresPreparationHold } from "./side-effects.ts";

export {
  type ResolvedMultipartPart,
  type RunRequestStepParams,
  requestEgressActor,
} from "./drivers/context.ts";
export { classifyTransportError } from "./http-attempt.ts";

export const REQUEST_TIMEOUT_DEFAULT_MS = 60 * 60_000;

export async function runRequestStep(p: RunRequestStepParams): Promise<StepResult> {
  const dispatchedEffects: Array<"read" | "write"> = [];
  const ownCredentials: string[] = [];
  let result = redactKnownValues(
    await dispatchRequestStep(
      p,
      (effect) => {
        dispatchedEffects.push(effect);
      },
      ownCredentials,
    ),
    ownCredentials,
  );
  if (
    (p.step.transactional_delivery || p.step.outbox_delivery) &&
    result.status === "succeeded" &&
    !result.held &&
    !isConfirmedTransactionalMail(result)
  )
    result = {
      ...result,
      status: "failed",
      error: {
        code: "transactional_delivery_unknown",
        message: "Gmail did not confirm a message ID; inspect the receipt before any resend",
      },
    };
  if ((p.step.transactional_delivery || p.step.outbox_delivery) && !p.ctx.hold_writes)
    await settleTransactionalMail(
      p.ctx.db,
      {
        tenant_id: p.ctx.tenant_id,
        execution_id: p.ctx.execution_id,
        step_id: p.step.id,
      },
      result,
    );
  if (!dispatchedEffects.length) return result;
  const metadata: RequestMeta = result.request_meta ?? { driver: "error", url: null };
  return {
    ...result,
    request_meta: {
      ...metadata,
      extras: {
        ...metadata.extras,
        effect_kind: dispatchedEffects.includes("write") ? "write" : "read",
      },
    },
  };
}

function filterDriverResult(
  d: RequestDispatch,
  driver: RequestStepDriver,
  result: StepResult,
): StepResult {
  const filters = d.p.step.response_filters;
  if (driver.capabilities.response_filters !== "result") return result;
  if (result.status !== "succeeded" || result.held || !filters || filters.length === 0)
    return result;
  try {
    return { ...result, output: applyResponseFilters(filters, result.output) };
  } catch (err) {
    if (err instanceof ResponseFilterFailError) {
      return {
        status: "failed",
        retry_count: result.retry_count,
        duration_ms: d.clock.now() - d.start,
        error: { code: "filter_fail", message: err.message },
        ...(result.request_meta ? { request_meta: result.request_meta } : {}),
      };
    }
    return failedStep(d, buildStepErrorDetail({ code: driver.capabilities.failure_code, err }));
  }
}

async function runDriver(d: RequestDispatch, driver: RequestStepDriver): Promise<StepResult> {
  const result =
    d.p.step.pagination && driver.paginate ? await driver.paginate(d) : await driver.execute(d);
  return filterDriverResult(d, driver, result);
}

async function resolveConnector(
  d: Pick<RequestDispatch, "p" | "clock" | "start" | "state">,
): Promise<
  | {
      connector: RequestConnector;
      resolution: NonNullable<RequestDispatch["connector_resolution"]>;
    }
  | { result: StepResult }
> {
  const { p, state } = d;
  const connectorId = p.step.connector_id as string;
  const connector = await getConnectorForEnvironment(
    p.ctx.tenant_id,
    connectorId,
    p.ctx.execution_mode,
    p.ctx.db,
  );
  if (!connector) {
    return {
      result: failedStep(d, {
        code: "connector_not_found",
        message: `connector ${connectorId} not found`,
      }),
    };
  }
  state.configurationDigest = authorityConnectorDigest(connector);
  state.holdThisStep =
    p.ctx.hold_writes === true &&
    requestRequiresPreparationHold(p.step, connector.driver, connector.base_url);
  const resolution = {
    step_key: p.step.id,
    connector_id: connector.id,
    connector_slug: connector.slug,
    requested_environment: p.ctx.execution_mode,
    resolved_environment: connector.environment,
    driver: connector.driver,
    auth_method: deriveAuthMethodFromAuthType(connector.auth_type),
    base_url: connector.base_url ?? null,
  };
  if (connector.environment !== p.ctx.execution_mode) {
    logger.warn({
      module: "connectors",
      action: "connector.environment.fallback",
      msg: "connector resolved to a different environment than requested — the run may be hitting the dev binding",
      tenant_id: p.ctx.tenant_id,
      connector_id: connector.id,
      connector_slug: connector.slug,
      requested_environment: p.ctx.execution_mode,
      resolved_environment: connector.environment,
    });
    try {
      getMetrics().inc(METRIC_NAMES.CONNECTOR_ENV_FALLBACK_TOTAL, {
        connector_id: connector.id,
        requested_environment: p.ctx.execution_mode,
        resolved_environment: connector.environment,
      });
    } catch {}
  }
  const refusal = connectorStepRefusal(connector, p.step, p.ctx.execution_mode);
  if (refusal) return { result: failedStep(d, refusal) };
  if (connector.circuit_state === "open") {
    if (isCircuitOpenBlocking(connector)) {
      return {
        result: failedStep(d, {
          code: "circuit_open",
          message: "connector circuit breaker is open — requests blocked until reset",
        }),
      };
    }
    await persistCircuitState(p.ctx.db, connector, { circuit_state: "half-open" });
  }
  return { connector, resolution };
}

async function resolveRequestParts(
  d: Pick<RequestDispatch, "p" | "clock" | "start" | "resolver">,
  partsCtx: RequestDispatch["resolver"],
): Promise<ResolvedRequestParts | { result: StepResult }> {
  const { p, resolver: resolverCtx } = d;
  const pathRes = p.step.path ? await resolveStringPlaceholders(p.step.path, resolverCtx) : null;
  const urlRes = p.step.url ? await resolveStringPlaceholders(p.step.url, resolverCtx) : null;
  const headersRes = p.step.headers ? await resolvePlaceholders(p.step.headers, partsCtx) : null;
  const queryRes = p.step.query ? await resolveRequestQuery(p.step.query, partsCtx) : null;
  if (queryRes && queryRes.omitted.length > 0)
    logger.debug({
      module: "request",
      action: "query_null_params_omitted",
      execution_id: p.ctx.execution_id,
      step_id: p.step.id,
      omitted_keys: queryRes.omitted,
    });
  const bodyRes =
    p.step.body !== undefined && p.step.body !== null
      ? await resolvePlaceholdersTypePreserving(p.step.body, partsCtx)
      : null;
  const formRes = p.step.form ? await resolveRequestQuery(p.step.form, partsCtx) : null;
  if (formRes && formRes.omitted.length > 0)
    logger.debug({
      module: "request",
      action: "form_null_fields_omitted",
      execution_id: p.ctx.execution_id,
      step_id: p.step.id,
      omitted_keys: formRes.omitted,
    });
  const idempotencyKeyRes =
    p.step.idempotency_key !== undefined
      ? await resolveStringPlaceholders(p.step.idempotency_key, partsCtx)
      : null;
  const credentialUnresolved = [
    ...(headersRes?.unresolved ?? []),
    ...(queryRes?.unresolved ?? []),
    ...(bodyRes?.unresolved ?? []),
    ...(formRes?.unresolved ?? []),
    ...(idempotencyKeyRes?.unresolved ?? []),
  ].filter((u) => /^\$\{\s*(?:cred|secret)\./.test(u.token));
  if (credentialUnresolved.length > 0) {
    return {
      result: failedStep(
        d,
        {
          code: "placeholder_unresolved",
          message: `credential placeholder(s) not resolved and not sent: ${credentialUnresolved
            .map((u) => `${u.token} (${u.code})`)
            .join(", ")}`,
          details: { unresolved: credentialUnresolved },
        },
        {
          request_meta: {
            driver: "error",
            url: null,
            method: p.step.method,
            unresolved_placeholders: credentialUnresolved.map((u) => u.token),
          },
        },
      ),
    };
  }
  const pathUrlUnresolved = [...(pathRes?.unresolved ?? []), ...(urlRes?.unresolved ?? [])];
  if (pathUrlUnresolved.length > 0) {
    const tokens = pathUrlUnresolved.map((u) => u.token).join(", ");
    return {
      result: failedStep(
        d,
        {
          code: "placeholder_unresolved",
          message: `unresolved placeholder(s) in path/url: ${tokens}`,
          details: { unresolved: pathUrlUnresolved },
        },
        {
          request_meta: {
            driver: "error",
            url: null,
            method: p.step.method,
            unresolved_placeholders: pathUrlUnresolved.map((u) => u.token),
          },
        },
      ),
    };
  }
  const stepHeaders =
    (headersRes?.value as Record<string, string> | undefined) ?? p.step.headers ?? {};
  const stepQuery = queryRes?.value ?? p.step.query ?? {};
  const s3KeyRes = p.step.s3?.key
    ? await resolveStringPlaceholders(p.step.s3.key, resolverCtx)
    : null;
  const s3PrefixRes = p.step.s3?.prefix
    ? await resolveStringPlaceholders(p.step.s3.prefix, resolverCtx)
    : null;
  const sftpPathRes = p.step.sftp?.path
    ? await resolveStringPlaceholders(p.step.sftp.path, resolverCtx)
    : null;
  const resolveSqlParams = async (rawParams: readonly unknown[]): Promise<unknown[]> => {
    const resolvedParams: unknown[] = [];
    for (const raw of rawParams) {
      resolvedParams.push(
        typeof raw === "string" ? (await resolveStringPlaceholders(raw, resolverCtx)).value : raw,
      );
    }
    return resolvedParams;
  };
  const sqlParams =
    p.step.sql && Array.isArray(p.step.sql.params)
      ? await resolveSqlParams(p.step.sql.params)
      : undefined;
  let sqlAlsoParams: unknown[][] | undefined;
  if (p.step.sql?.also && p.step.sql.also.length > 0) {
    sqlAlsoParams = [];
    for (const alsoStatement of p.step.sql.also) {
      sqlAlsoParams.push(await resolveSqlParams(alsoStatement.params ?? []));
    }
  }
  const mcpTarget =
    p.step.mcp?.operation === "read_resource"
      ? p.step.mcp.uri
      : p.step.mcp?.operation === "get_prompt"
        ? p.step.mcp.prompt
        : p.step.mcp?.tool;
  const mcpTargetRes = mcpTarget ? await resolveStringPlaceholders(mcpTarget, resolverCtx) : null;
  const mcpArgsRes =
    p.step.mcp?.arguments !== undefined
      ? await resolvePlaceholdersTypePreserving(p.step.mcp.arguments, resolverCtx)
      : null;
  let body = bodyRes ? bodyRes.value : p.step.body;
  const headers: Record<string, string> = { ...stepHeaders };
  if (p.step.xml !== undefined) {
    const xmlBodyRes = await resolvePlaceholders(p.step.xml.body, resolverCtx);
    const tree = (xmlBodyRes?.value as unknown) ?? p.step.xml.body;
    const xmlText = serializeXmlBody(tree);
    body = p.step.xml.declaration ? `<?xml version="1.0" encoding="UTF-8"?>${xmlText}` : xmlText;
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type"))
      headers["Content-Type"] = "application/xml";
  }
  if (formRes) {
    body = new URLSearchParams(
      Object.entries(formRes.value).map(([name, value]) => [name, String(value)]),
    ).toString();
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type"))
      headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  if (
    idempotencyKeyRes &&
    idempotencyKeyRes.value.length > 0 &&
    !Object.keys(headers).some((k) => k.toLowerCase() === "idempotency-key")
  )
    headers["Idempotency-Key"] = idempotencyKeyRes.value;
  return {
    path: pathRes?.value ?? p.step.path ?? null,
    url: urlRes?.value ?? p.step.url ?? null,
    step_headers: stepHeaders,
    headers,
    query: { ...stepQuery },
    body,
    s3_key: s3KeyRes?.value ?? p.step.s3?.key,
    s3_prefix: s3PrefixRes?.value ?? p.step.s3?.prefix,
    sftp_path: sftpPathRes?.value ?? p.step.sftp?.path,
    sql_params: sqlParams,
    sql_also_params: sqlAlsoParams,
    mcp_target: mcpTargetRes,
    mcp_arguments: mcpArgsRes,
  };
}

async function dispatchRequestStep(
  p: RunRequestStepParams,
  recordEffect: (effect: "read" | "write") => void,
  ownCredentials: string[],
): Promise<StepResult> {
  const clock = p.ctx.clock ?? SYSTEM_CLOCK;
  const start = clock.now();
  const referencedCredentials: CredentialUseSnapshot[] = [];
  const persistCredentialUse = async (snapshot?: CredentialUseSnapshot) => {
    const captured = [...referencedCredentials, ...(snapshot ? [snapshot] : [])];
    const unique = new Map(captured.map((entry) => [JSON.stringify(entry), entry]));
    for (const entry of unique.values())
      await appendCredentialSnapshot(
        p.ctx.db,
        p.ctx.tenant_id,
        p.ctx.execution_id,
        p.ctx.step_row_id,
        entry,
      );
  };
  const referencedAuthorities: ResolvedAuthorityReference[] = [
    ...(p.ctx.prepared_workflow_references ?? []),
  ];
  const state: DispatchState = {
    activeConnector: null,
    credentialSnapshot: {
      credential_id: null,
      credential_revision: null,
      connection_authority: null,
    },
    configurationDigest: authorityConnectorDigest(null),
    holdThisStep: p.ctx.hold_writes === true && requestRequiresPreparationHold(p.step),
  };
  const max_attempts = requestMaxAttempts(p.step);
  const timeoutMs = p.step.timeout_ms ?? REQUEST_TIMEOUT_DEFAULT_MS;
  const timeoutCtrl = new AbortController();
  const rateLimitBound = rateLimitDeadline(timeoutMs, p.ctx.workflow_deadline_ms);
  const resolvedScope = await resolveScopeForJsonata(
    p.ctx.db,
    p.ctx.tenant_id,
    p.scope,
    p.ctx.signal,
  );
  const authoritySnapshot = (credential: CredentialSnapshot = state.credentialSnapshot) => ({
    ...(referencedAuthorities.length ? { referenced_authorities: referencedAuthorities } : {}),
    step_id: p.step.id,
    step_row_id: p.ctx.step_row_id,
    connector_id: p.step.connector_id ?? null,
    requires_review: requestRequiresPreparationHold(
      p.step,
      state.activeConnector?.driver,
      state.activeConnector?.base_url,
    ),
    request_max_attempts: max_attempts,
    ...(p.step.transactional_delivery || p.step.outbox_delivery
      ? { requires_transactional_authority: true }
      : {}),
    ...(p.step.outbox_delivery
      ? {
          outbox_source: outboxSourceFacts(
            p.step.outbox_delivery,
            resolvedScope?.[p.step.outbox_delivery.source_step_id],
          ),
        }
      : {}),
    principal_id: p.ctx.principal?.id ?? null,
    configuration_digest: state.configurationDigest,
    credential_id: credential.credential_id,
    credential_revision: credential.credential_revision,
    connection_authority: credential.connection_authority ?? null,
  });
  const beforeDispatch = async (
    credential: CredentialSnapshot = state.credentialSnapshot,
    request?: MaterializedRequest,
  ) => {
    try {
      if (
        (p.step.transactional_delivery || p.step.outbox_delivery) &&
        !p.ctx.before_external_request
      )
        throw Object.assign(
          new Error("Transactional email requires execution authority enforcement"),
          { code: "execution_authority_required" },
        );
      const documentedRead = p.step.side_effects !== "write" && isDocumentedReadOperation(request);
      const effect = documentedRead
        ? "read"
        : classifyRequestStepSideEffects(
            p.step,
            state.activeConnector?.driver,
            request?.method,
            state.activeConnector?.base_url,
          );
      const policy = await p.ctx.before_external_request?.({
        ...authoritySnapshot(credential),
        ...(documentedRead ? { requires_review: false } : {}),
        ...(request ? { request } : {}),
        dispatch_effect: effect,
      });
      await persistCredentialUse(credential.credential_snapshot);
      recordEffect(effect);
      return documentedRead ? { redirect: "manual" as const } : policy;
    } catch (error) {
      throw new RequestError(
        `Execution authority could not be verified: ${(error as { code?: string }).code ?? "authority_check_failed"}; review the current boundary.`,
        "authority_invalid",
        undefined,
        {
          reason: (error as { code?: string }).code ?? "authority_check_failed",
          ...(typeof (error as { reason?: unknown }).reason === "string"
            ? { refusal_reason: (error as { reason: string }).reason }
            : {}),
        },
      );
    }
  };

  const timer = setTimeout(() => timeoutCtrl.abort("timeout"), timeoutMs);
  const signal = combineSignals([p.ctx.signal, timeoutCtrl.signal]);
  try {
    const resolver = {
      onCredentialUse: (snapshot: CredentialUseSnapshot) => {
        referencedCredentials.push(snapshot);
      },
      onAuthorityReference: (reference: ResolvedAuthorityReference) => {
        if (
          !referencedAuthorities.some(
            (existing) =>
              existing.connector_id === reference.connector_id &&
              existing.configuration_digest === reference.configuration_digest &&
              existing.credential_id === reference.credential_id &&
              existing.credential_revision === reference.credential_revision,
          )
        )
          referencedAuthorities.push(reference);
      },
      tenant_id: p.ctx.tenant_id,
      environment: p.ctx.execution_mode,
      db: p.ctx.db,
      input: resolvedScope?.$input,
      scope: resolvedScope,
      ...(p.ctx.principal ? { principal: p.ctx.principal } : {}),
    };
    const ownConnector =
      p.step.connector_id && p.ctx.own_connector_credentials === true && !p.ctx.hold_writes
        ? await getConnectorForEnvironment(
            p.ctx.tenant_id,
            p.step.connector_id,
            p.ctx.execution_mode,
            p.ctx.db,
          ).catch(() => null)
        : null;
    const partsCtx =
      ownConnector && ownConnector.environment === p.ctx.execution_mode
        ? {
            ...resolver,
            vault: {
              values: await prepareStepVault(
                p.ctx.db,
                {
                  tenant_id: p.ctx.tenant_id,
                  environment: p.ctx.execution_mode,
                  user_id: p.ctx.principal?.kind === "user" ? p.ctx.principal.id : null,
                  execution_id: p.ctx.execution_id,
                  step_id: p.step.id,
                },
                [p.step.headers, p.step.query, p.step.body, p.step.form, p.step.idempotency_key],
              ),
              onSecret: (value: string) => {
                ownCredentials.push(value);
              },
            },
            own_connector: {
              id: ownConnector.id,
              onSecret: (value: string) => {
                ownCredentials.push(value);
              },
            },
          }
        : resolver;
    const protocol = connectorlessProtocol(p.step);
    if (protocol) {
      logger.warn({
        module: "connectors",
        action: "request.connectorless_protocol.refused",
        msg: "request step declares a protocol block without a connector — refused before dispatch",
        tenant_id: p.ctx.tenant_id,
        execution_id: p.ctx.execution_id,
        step_id: p.step.id,
        protocol,
      });
      return failedStep(
        { clock, start },
        {
          code: "connector_driver_mismatch",
          message: `a ${protocol} block needs connector_id: bind the step to a ${protocol} connector (recipes declare it in required_connectors) — without one the request would go out as an empty, unauthenticated HTTP call`,
        },
      );
    }
    const timing = { p, clock, start, state, resolver };
    const parts = await resolveRequestParts(timing, partsCtx);
    if ("result" in parts) return parts.result;

    let connector: RequestConnector | null = null;
    let connectorResolution: RequestDispatch["connector_resolution"] = null;
    if (p.step.connector_id) {
      try {
        const resolved = await resolveConnector(timing);
        if ("result" in resolved) return resolved.result;
        connector = resolved.connector;
        connectorResolution = resolved.resolution;
      } catch (err) {
        return setupFailure(timing, err);
      }
    }
    const d: RequestDispatch = {
      p,
      clock,
      start,
      signal,
      timeout_ms: timeoutMs,
      timeout_ctrl: timeoutCtrl,
      max_attempts,
      rate_limit: rateLimitBound,
      resolver,
      connector,
      connector_resolution: connectorResolution,
      parts,
      state,
      own_credentials: ownCredentials,
      own_connector: ownConnector,
      authority_snapshot: authoritySnapshot,
      before_dispatch: beforeDispatch,
      persist_credential_use: persistCredentialUse,
      record_effect: recordEffect,
    };
    const driver = lookupDriver(
      DRIVERS,
      connector ? requestDriverKind(connector.driver, p.step) : "http",
    );
    if (!driver) {
      return failedStep(d, {
        code: "connector_driver_mismatch",
        message: `request step has no dispatch path for connector driver '${connector?.driver}'`,
      });
    }
    if (!driver.capabilities.step_timer) clearTimeout(timer);
    if (driver.capabilities.owns_setup_errors) return await runDriver(d, driver);
    try {
      return await runDriver(d, driver);
    } catch (err) {
      return setupFailure(d, err);
    }
  } finally {
    clearTimeout(timer);
  }
}
