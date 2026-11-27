import type { DecryptedCredential } from "../../../credentials/types.ts";
import type { Db } from "../../../db/client.ts";
import { resolveSigV4Target } from "../../core/http-request.ts";
import { connectorLocalScope } from "../../local-egress.ts";
import type { ConnectorView } from "../../types.ts";
import { executePlannedHttpRequest, FETCH_DEADLINE_MS } from "./dispatch.ts";
import { buildRequestPlan, type ResolveConnectorRequestParams } from "./plan.ts";
import type {
  HttpExecutionResult,
  RequestDispatchPolicy,
  ResolvedConnectorCredential,
} from "./types.ts";

export interface ConnectorHttpResult extends HttpExecutionResult {
  stored_credential_used: boolean;
}

function requestSignal(
  signal: AbortSignal | undefined,
  timeout_ms: number | undefined,
): AbortSignal {
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (timeout_ms !== undefined) signals.push(AbortSignal.timeout(timeout_ms));
  return signals.length === 0
    ? AbortSignal.timeout(FETCH_DEADLINE_MS)
    : signals.length === 1
      ? signals[0]!
      : AbortSignal.any(signals);
}

export async function executeConnectorHttpRequest(params: {
  before_dispatch?: (
    credential: Pick<
      ResolvedConnectorCredential,
      "credential_id" | "credential_revision" | "connection_authority" | "credential_snapshot"
    >,
  ) => Promise<RequestDispatchPolicy | undefined>;
  db: Db;
  tenant_id: string;
  connector: ConnectorView;
  method: string;
  path_or_url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  signal?: AbortSignal;
  timeout_ms?: number;
  credential_override?: DecryptedCredential | null;
  idempotency_key?: string;
}): Promise<ConnectorHttpResult> {
  const planArgs: ResolveConnectorRequestParams = {
    db: params.db,
    tenant_id: params.tenant_id,
    connector: params.connector,
    path_or_url: params.path_or_url,
    ...(params.headers ? { headers: params.headers } : {}),
    ...(params.query ? { query: params.query } : {}),
    ...(params.credential_override ? { credential_override: params.credential_override } : {}),
    ...(params.idempotency_key ? { idempotency_key: params.idempotency_key } : {}),
  };
  const plan = await buildRequestPlan(planArgs);
  const signal = requestSignal(params.signal, params.timeout_ms);

  let sigv4Args: Parameters<typeof executePlannedHttpRequest>[0]["sigv4"] | undefined;
  if (plan.credential?.mode === "aws_sigv4") {
    const target = resolveSigV4Target(params.connector.config, params.connector.id);
    sigv4Args = { region: target.region, service: target.service, credential: plan.credential };
  }

  const beforeDispatch = params.before_dispatch;
  const signedJwt = plan.credential?.mode === "signed_jwt";
  const localScope = connectorLocalScope(params.connector);
  const result = await executePlannedHttpRequest({
    exec: params.db,
    tenant_id: params.tenant_id,
    ...(localScope ? { local_scope: localScope } : {}),
    method: params.method,
    url: plan.url,
    headers: plan.headers,
    body: params.body,
    signal,
    ...(sigv4Args ? { sigv4: sigv4Args } : {}),
    ...(plan.credential?.mode === "signed_jwt"
      ? { signed_jwt: { connector: params.connector, credential: plan.credential } }
      : {}),
    ...(beforeDispatch || signedJwt
      ? {
          before_dispatch: async () => {
            const policy = beforeDispatch
              ? await beforeDispatch({
                  ...(plan.credential_snapshot
                    ? { credential_snapshot: plan.credential_snapshot }
                    : {}),
                  credential_id: plan.credential_id,
                  credential_revision: plan.credential_revision,
                  connection_authority: plan.connection_authority ?? null,
                })
              : undefined;
            return signedJwt ? { redirect: "manual" } : policy;
          },
        }
      : {}),
  });
  return { ...result, stored_credential_used: plan.stored_credential_used };
}
