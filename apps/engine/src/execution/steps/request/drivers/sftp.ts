import {
  clearReauthIfProved,
  EgressBlockedError,
  executeSftpRequest,
  SftpConnectorError,
  type SftpMethod,
  SftpRefusal,
  type SftpResponse,
  sftpAuthenticationFailed,
  withEgressAudit,
} from "../../../../connectors/index.ts";
import type { ResolvedFile } from "../../../../files/index.ts";
import type { ConnectorResolutionSummary, RequestMeta, StepResult } from "../../../types.ts";
import { buildStepErrorDetail } from "../../error-detail.ts";
import { evidenceFromStatus, evidenceFromThrow } from "../circuit-evidence.ts";
import { promoteResponseToFile } from "../file-output.ts";
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

async function fileBytes(file: ResolvedFile): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of await file.openRead()) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function putBody(d: RequestDispatch): Promise<Buffer | null> {
  if (d.p.resolved_body_file) return fileBytes(d.p.resolved_body_file);
  const body = d.parts.body;
  if (body === undefined || body === null) return null;
  return Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

function sftpErrorCode(err: unknown): string {
  if (err instanceof SftpRefusal) return err.code;
  if (err instanceof SftpConnectorError) return err.error_code;
  if (err instanceof EgressBlockedError) return "egress_blocked";
  if (sftpAuthenticationFailed(err)) return "credential_invalid";
  return "sftp_error";
}

async function stepOutput(d: RequestDispatch, res: SftpResponse): Promise<unknown> {
  if (res.entries)
    return { path: res.path, entries: res.entries, truncated: res.truncated === true };
  if (res.file) {
    const { p } = d;
    return promoteResponseToFile({
      db: p.ctx.db,
      tenant_id: p.ctx.tenant_id,
      actor_id: p.ctx.principal?.id ?? null,
      execution_id: p.ctx.execution_id,
      step_id: p.step.id,
      filename: res.file.filename,
      content_type: null,
      bytes: res.file.bytes,
    });
  }
  return { path: res.path, ...(res.bytes_out !== undefined ? { size_bytes: res.bytes_out } : {}) };
}

async function executeSftp(d: RequestDispatch): Promise<StepResult> {
  const { p } = d;
  const connector = requireConnector(d);
  const connectorMeta = d.connector_resolution as ConnectorResolutionSummary;
  const method = (p.step.method ?? "GET") as SftpMethod;
  const path = d.parts.sftp_path ?? "";
  const meta = (extra: Partial<Extract<RequestMeta, { driver: "sftp" }>>): RequestMeta => ({
    driver: "sftp",
    method,
    path,
    connector: connectorMeta,
    ...extra,
  });
  try {
    const body = method === "PUT" ? await putBody(d) : null;
    if (method === "DELETE" && d.parts.body !== undefined && d.parts.body !== null)
      return failedStep(d, {
        code: "sftp_delete_body_refused",
        message:
          "sftp DELETE does not accept a body — remove one file per request (for_each with sftp.path)",
      });
    if (d.state.holdThisStep) {
      return heldStepResult({
        start: d.start,
        clock: d.clock,
        method,
        url: path,
        body: body ? { size_bytes: body.byteLength } : null,
      });
    }
    const res = await withEgressAudit(
      {
        ...egressScope(d),
        connector_id: connector.id,
        connector_slug: connector.slug,
        driver: "sftp",
        credential_id: null,
        operation: method,
        url: null,
      },
      () =>
        executeSftpRequest({
          db: p.ctx.db,
          tenant_id: p.ctx.tenant_id,
          connector,
          method,
          path,
          ...(body ? { body } : {}),
          ...(p.step.sftp?.max_entries !== undefined
            ? { max_entries: p.step.sftp.max_entries }
            : {}),
          timeout_ms: d.timeout_ms,
          on_credential_use: async (snapshot) => {
            const effect = classifyRequestStepSideEffects(p.step, "sftp");
            if (effect === "write") await p.ctx.before_write_dispatch?.(p.ctx.step_row_id);
            await d.persist_credential_use(snapshot);
            d.record_effect(effect);
          },
        }),
      (out) => ({ status: out.status, bytes_in: out.file?.bytes.byteLength ?? null }),
    );
    await recordDriverOutcome(p.ctx.db, connector, evidenceFromStatus(res.status));
    const summary = meta({
      status: res.status,
      ...(res.entries ? { entry_count: res.entries.length } : {}),
      ...(res.file ? { bytes_in: res.file.bytes.byteLength } : {}),
      ...(res.bytes_out !== undefined ? { bytes_out: res.bytes_out } : {}),
    });
    const expected = p.step.expected_statuses;
    if (expected && expected.length > 0 && !expected.includes(res.status))
      return failedStep(
        d,
        {
          code: "unexpected_status_code",
          message: `expected one of ${JSON.stringify(expected)}, got ${res.status}`,
        },
        { request_meta: summary },
      );
    if (res.status < 200 || res.status >= 300)
      return failedStep(
        d,
        {
          code: res.status === 404 ? "sftp_not_found" : "sftp_permission_denied",
          message:
            res.status === 404
              ? `${path} does not exist on the server`
              : `the server refused access to ${path}`,
        },
        { request_meta: summary },
      );
    await clearReauthIfProved(p.ctx.db, connector, {
      status: res.status,
      health: "ok",
      stored_credential_used: true,
    });
    return {
      status: "succeeded",
      output: await stepOutput(d, res),
      retry_count: 0,
      duration_ms: elapsed(d),
      request_meta: summary,
    };
  } catch (err) {
    await recordDriverOutcome(p.ctx.db, connector, evidenceFromThrow(err));
    return failedStep(d, buildStepErrorDetail({ code: sftpErrorCode(err), err }), {
      request_meta: meta({}),
    });
  }
}

export const sftpRequestDriver: RequestStepDriver & { readonly kind: "sftp" } = {
  kind: "sftp",
  capabilities: {
    retry: "none",
    pagination: "none",
    response_filters: "none",
    circuit_close: "outcome",
    step_timer: false,
    owns_setup_errors: false,
    failure_code: "sftp_error",
  },
  retryPolicy: () => null,
  classifySideEffects: (step, method, baseUrl) =>
    classifyRequestStepSideEffects(step, "sftp", method, baseUrl),
  execute: executeSftp,
};
