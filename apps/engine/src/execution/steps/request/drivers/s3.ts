import {
  executeS3Request,
  S3CredentialError,
  type S3Method,
} from "../../../../connectors/drivers/s3.ts";
import { withEgressAudit } from "../../../../connectors/egress.ts";
import { classifyConnectorHealth } from "../../../../connectors/health.ts";
import { clearReauthIfProved } from "../../../../connectors/reauth.ts";
import { recordSuccessShape } from "../../../../schema-versions/service.ts";
import {
  describeStorageKeyViolation,
  storageBaseUrl,
  storageBoundary,
  storageKeyViolation,
} from "../../../../workflows/storage-boundary.ts";
import type { ConnectorResolutionSummary, StepResult } from "../../../types.ts";
import { buildStepErrorDetail } from "../../error-detail.ts";
import { evidenceFromStatus, evidenceFromThrow } from "../circuit-evidence.ts";
import { classifyRequestStepSideEffects, heldStepResult } from "../side-effects.ts";
import {
  egressScope,
  elapsed,
  failedStep,
  type RequestDispatch,
  type RequestStepDriver,
  recordDriverOutcome,
  requireConnector,
} from "./context.ts";

function parseS3Output(raw: unknown, parseAs: "json" | "base64" | "bytes" | "text"): unknown {
  const buf = Buffer.isBuffer(raw)
    ? raw
    : raw instanceof Uint8Array
      ? Buffer.from(raw)
      : typeof raw === "string"
        ? Buffer.from(raw, "utf8")
        : Buffer.from(String(raw ?? ""), "utf8");
  if (parseAs === "json") {
    try {
      return JSON.parse(buf.toString("utf8"));
    } catch {
      return buf.toString("utf8");
    }
  }
  if (parseAs === "base64") return buf.toString("base64");
  if (parseAs === "bytes") return buf;
  return buf.toString("utf8");
}

async function executeS3(d: RequestDispatch): Promise<StepResult> {
  const { p } = d;
  const connector = requireConnector(d);
  const connectorMeta = d.connector_resolution as ConnectorResolutionSummary;
  try {
    const s3Spec = p.step.s3;
    const method = (p.step.method ?? "GET") as S3Method;
    const objectPath = d.parts.s3_key;
    const resolvedPrefix = d.parts.s3_prefix;
    const reqPath =
      method === "LIST"
        ? `/${(resolvedPrefix ?? "").replace(/^\/+/, "")}`
        : objectPath
          ? `/${objectPath.replace(/^\/+/, "")}`
          : (d.parts.path ?? d.parts.url ?? "/");
    const params: Parameters<typeof executeS3Request>[0] = {
      on_credential_use: async (snapshot) => {
        await d.persist_credential_use(snapshot);
        d.record_effect(
          classifyRequestStepSideEffects(
            p.step,
            d.state.activeConnector?.driver,
            undefined,
            d.state.activeConnector?.base_url,
          ),
        );
      },
      db: p.ctx.db,
      tenant_id: p.ctx.tenant_id,
      connector,
      method,
      path: reqPath,
      ...(s3Spec?.scope
        ? { before_dispatch: d.before_dispatch, signal: d.signal, timeout_ms: d.timeout_ms }
        : {}),
    };
    const resolvedStepBody = d.parts.body;
    if (resolvedStepBody !== undefined && resolvedStepBody !== null) {
      params.body =
        typeof resolvedStepBody === "string" ? resolvedStepBody : JSON.stringify(resolvedStepBody);
    }
    if (s3Spec?.content_type) {
      params.contentType = s3Spec.content_type;
    }
    if (s3Spec?.metadata) {
      params.metadata = s3Spec.metadata;
    }
    if (typeof s3Spec?.max_keys === "number") {
      params.maxKeys = s3Spec.max_keys;
    }
    if (s3Spec?.paginate !== undefined) params.paginate = s3Spec.paginate;
    if (s3Spec?.multipart !== undefined) params.multipart = s3Spec.multipart;
    if (s3Spec?.multipart_threshold_mb !== undefined) {
      params.multipartThresholdMb = s3Spec.multipart_threshold_mb;
    }
    if (s3Spec?.range !== undefined) params.range = s3Spec.range;
    if (s3Spec?.presign !== undefined) {
      params.presignExpiresIn = s3Spec.presign.expires_in_s;
    }
    if (s3Spec?.scope) {
      const declared = storageBoundary(p.step, storageBaseUrl(connector.config));
      if (!declared)
        return failedStep(d, {
          code: "request_outside_declared_boundary",
          message: "The declared storage scope cannot be enforced. Nothing was sent.",
        });
      const violation = storageKeyViolation(
        declared,
        reqPath.replace(/^\//, ""),
        params.body ?? null,
        p.ctx.caller_context ?? null,
      );
      if (violation)
        return failedStep(
          d,
          {
            code: "request_outside_declared_boundary",
            message:
              `This request is outside the folder boundary its step declares: ${describeStorageKeyViolation(violation)}. ` +
              "Nothing was sent. Correct `s3.scope` on this step so it covers every key and the " +
              "largest content the workflow can produce; do not remove the scope and do not " +
              "widen it to the whole bucket.",
          },
          {
            request_meta: {
              driver: "s3",
              method,
              refused: true,
              key: reqPath.replace(/^\//, ""),
              ...(typeof params.body === "string"
                ? { bytes_out: new TextEncoder().encode(params.body).byteLength }
                : {}),
              connector: connectorMeta,
            },
          },
        );
    }
    if (d.state.holdThisStep) {
      return heldStepResult({
        start: d.start,
        clock: d.clock,
        method,
        url: reqPath,
        headers: d.parts.step_headers,
        body: params.body ?? null,
      });
    }
    const res = await withEgressAudit(
      {
        ...egressScope(d),
        connector_id: connector.id,
        connector_slug: connector.slug,
        driver: "s3",
        credential_id: null,
        operation: method,
        url: null,
      },
      () => executeS3Request(params),
      (out) => ({ status: out.status }),
    );
    const output: unknown =
      method === "GET" && s3Spec?.parse_as ? parseS3Output(res.body, s3Spec.parse_as) : res.body;
    if (
      Array.isArray(p.step.expected_statuses) &&
      p.step.expected_statuses.length > 0 &&
      !p.step.expected_statuses.includes(res.status)
    ) {
      return failedStep(
        d,
        {
          code: "unexpected_status_code",
          message: `expected one of ${JSON.stringify(p.step.expected_statuses)}, got ${res.status}`,
        },
        {
          request_meta: {
            driver: "s3",
            method,
            status: res.status,
            ...(objectPath ? { key: objectPath } : {}),
            ...(resolvedPrefix ? { prefix: resolvedPrefix } : {}),
            connector: connectorMeta,
          },
        },
      );
    }

    if (res.status >= 200 && res.status < 300) {
      try {
        await recordSuccessShape(
          {
            tenant_id: p.ctx.tenant_id,
            connector_id: connector.id,
            endpoint_key: `S3 ${method} ${resolvedPrefix ?? objectPath ?? "/"}`,
            workflow_id: p.ctx.workflow_id,
            step_id: p.step.id,
            value: output,
          },
          p.ctx.db,
        );
      } catch {}
    }

    await recordDriverOutcome(p.ctx.db, connector, evidenceFromStatus(res.status));
    await clearReauthIfProved(p.ctx.db, connector, {
      status: res.status,
      health: classifyConnectorHealth(res.status, res.headers),
      stored_credential_used: true,
    });

    return {
      status: res.status >= 200 && res.status < 300 ? "succeeded" : "failed",
      output,
      retry_count: 0,
      duration_ms: elapsed(d),
      request_meta: {
        driver: "s3",
        method,
        status: res.status,
        ...(objectPath ? { key: objectPath } : {}),
        ...(resolvedPrefix ? { prefix: resolvedPrefix } : {}),
        ...(typeof params.body === "string"
          ? { bytes_out: new TextEncoder().encode(params.body).byteLength }
          : {}),
        connector: connectorMeta,
      },
    };
  } catch (err) {
    await recordDriverOutcome(p.ctx.db, connector, evidenceFromThrow(err));
    if (err instanceof S3CredentialError) {
      return failedStep(d, buildStepErrorDetail({ code: err.error_code, err }));
    }
    return failedStep(d, buildStepErrorDetail({ code: "s3_error", err }));
  }
}

export const s3RequestDriver: RequestStepDriver & { readonly kind: "s3" } = {
  kind: "s3",
  capabilities: {
    retry: "none",
    pagination: "s3_list",
    response_filters: "none",
    circuit_close: "outcome",
    step_timer: false,
    owns_setup_errors: false,
    failure_code: "s3_error",
  },
  retryPolicy: () => null,
  classifySideEffects: (step, method, baseUrl) =>
    classifyRequestStepSideEffects(step, "s3", method, baseUrl),
  execute: executeS3,
};
