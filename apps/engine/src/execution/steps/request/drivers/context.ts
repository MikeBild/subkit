import { normalizeAuditActorId } from "../../../../audit/audit.ts";
import type { AuditActorType } from "../../../../audit/types.ts";
import type { ResolvedPrincipal } from "../../../../auth/types.ts";
import {
  persistCircuitState,
  recordCircuitFailure,
} from "../../../../connectors/circuit-breaker.ts";
import type {
  RequestDispatchPolicy,
  ResolvedConnectorCredential,
} from "../../../../connectors/drivers/http.ts";
import type { Driver } from "../../../../connectors/drivers/port.ts";
import { EgressBlockedError, RobotsDisallowedError } from "../../../../connectors/egress-guard.ts";
import type { getConnectorForEnvironment } from "../../../../connectors/service.ts";
import type { CredentialUseSnapshot } from "../../../../credentials/index.ts";
import type { Db } from "../../../../db/client.ts";
import type { ResolvedFile } from "../../../../files/resolver.ts";
import type {
  resolvePlaceholders,
  resolveStringPlaceholders,
} from "../../../../llm/substitution/resolver.ts";
import type { RequestStep } from "../../../../workflows/types.ts";
import type { Clock } from "../../../clock.ts";
import type { MaterializedRequest } from "../../../prepared-request.ts";
import type {
  ConnectorResolutionSummary,
  RequestAuthoritySnapshot,
  StepErrorDetail,
  StepResult,
  StepRunContext,
} from "../../../types.ts";
import { buildStepErrorDetail } from "../../error-detail.ts";
import type { ConnectorEvidence } from "../circuit-evidence.ts";
import type { rateLimitDeadline } from "../rate-limit.ts";

export interface ResolvedMultipartPart {
  name: string;
  file?: ResolvedFile;
  value?: string;
  filename?: string;
  content_type?: string;
}

export interface RunRequestStepParams {
  ctx: StepRunContext;
  step: RequestStep;
  scope: Record<string, unknown>;
  resolved_multipart?: ResolvedMultipartPart[];
  resolved_body_file?: ResolvedFile;
}

export type RequestConnector = NonNullable<Awaited<ReturnType<typeof getConnectorForEnvironment>>>;

export type CredentialSnapshot = Pick<
  ResolvedConnectorCredential,
  "credential_id" | "credential_revision" | "connection_authority" | "credential_snapshot"
>;

type PlaceholderResult = Awaited<ReturnType<typeof resolveStringPlaceholders>>;
type ValueResult = Awaited<ReturnType<typeof resolvePlaceholders>>;
export type ResolverContext = Parameters<typeof resolveStringPlaceholders>[1];

export interface DispatchState {
  activeConnector: RequestConnector | null;
  credentialSnapshot: CredentialSnapshot;
  configurationDigest: string;
  holdThisStep: boolean;
}

export interface ResolvedRequestParts {
  path: string | null;
  url: string | null;
  step_headers: Record<string, string>;
  headers: Record<string, string>;
  query: Record<string, string | number | boolean>;
  body: unknown;
  s3_key: string | undefined;
  s3_prefix: string | undefined;
  sftp_path: string | undefined;
  sql_params: unknown[] | undefined;
  mcp_target: PlaceholderResult | null;
  mcp_arguments: ValueResult | null;
}

export interface RequestDispatch {
  p: RunRequestStepParams;
  clock: Clock;
  start: number;
  signal: AbortSignal;
  timeout_ms: number;
  timeout_ctrl: AbortController;
  max_attempts: number;
  rate_limit: ReturnType<typeof rateLimitDeadline>;
  resolver: ResolverContext;
  connector: RequestConnector | null;
  connector_resolution: ConnectorResolutionSummary | null;
  parts: ResolvedRequestParts;
  state: DispatchState;
  own_credentials: string[];
  own_connector: RequestConnector | null;
  authority_snapshot: (credential?: CredentialSnapshot) => RequestAuthoritySnapshot;
  before_dispatch: (
    credential?: CredentialSnapshot,
    request?: MaterializedRequest,
  ) => Promise<RequestDispatchPolicy | undefined>;
  persist_credential_use: (snapshot?: CredentialUseSnapshot) => Promise<void>;
  record_effect: (effect: "read" | "write") => void;
}

export type RequestStepDriver = Driver<RequestDispatch, StepResult, RequestStep>;

export function elapsed(d: Pick<RequestDispatch, "clock" | "start">): number {
  return d.clock.now() - d.start;
}

export function failedStep(
  d: Pick<RequestDispatch, "clock" | "start">,
  error: StepErrorDetail,
  extra: Partial<StepResult> = {},
): StepResult {
  return {
    status: "failed",
    retry_count: 0,
    duration_ms: elapsed(d),
    error,
    ...extra,
  };
}

export function requestEgressActor(
  principal: Pick<ResolvedPrincipal, "kind" | "id"> | null | undefined,
): { actor_type: AuditActorType; actor_id: string | null } {
  if (!principal) return { actor_type: "unknown", actor_id: null };
  return {
    actor_type: principal.kind,
    actor_id: normalizeAuditActorId(principal.id),
  };
}

export function egressScope(d: Pick<RequestDispatch, "p">): {
  executor: Db;
  tenant_id: string;
  actor_type: AuditActorType;
  actor_id: string | null;
  source: "execution";
  execution_id: string;
  workflow_id: string;
  step_id: string;
} {
  return {
    executor: d.p.ctx.db,
    tenant_id: d.p.ctx.tenant_id,
    ...requestEgressActor(d.p.ctx.principal),
    source: "execution",
    execution_id: d.p.ctx.execution_id,
    workflow_id: d.p.ctx.workflow_id,
    step_id: d.p.step.id,
  };
}

export async function recordDriverOutcome(
  db: Db,
  connector: {
    tenant_id: string;
    id: string;
    circuit_state: string;
    circuit_failure_count: number;
  },
  evidence: ConnectorEvidence,
): Promise<void> {
  if (evidence === "unavailable") {
    await recordCircuitFailure(db, connector);
    return;
  }
  if (evidence === "none") return;
  if (connector.circuit_state !== "half-open" && connector.circuit_failure_count === 0) return;
  await persistCircuitState(db, connector, { circuit_state: "closed", circuit_failure_count: 0 });
}

export function setupFailure(
  d: Pick<RequestDispatch, "clock" | "start">,
  err: unknown,
): StepResult {
  const code =
    err instanceof RobotsDisallowedError
      ? "robots_disallowed"
      : err instanceof EgressBlockedError
        ? "egress_blocked"
        : "request_setup_error";
  return failedStep(d, buildStepErrorDetail({ code, err }));
}

export function requireConnector(d: Pick<RequestDispatch, "connector">): RequestConnector {
  if (!d.connector) throw new Error("request driver requires a resolved connector");
  return d.connector;
}
