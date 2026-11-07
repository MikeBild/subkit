import type { Db } from "../../../db/client.ts";
import { _withEgressTenantOriginForTests } from "../../egress-guard.ts";
import type { ConnectorView } from "../../types.ts";

export const GRAPHQL_TENANT = "00000000-0000-4000-8000-0000000000c1";
export const GRAPHQL_ENDPOINT = "https://93.184.216.34/graphql";
export const unusedGraphqlDb = {} as Db;

export function graphqlConnector(overrides: Partial<ConnectorView> = {}): ConnectorView {
  return {
    id: "00000000-0000-4000-8000-0000000000c2",
    tenant_id: GRAPHQL_TENANT,
    slug: "fixture-graphql",
    driver: "graphql",
    environment: "dev",
    auth_type: "none",
    base_url: GRAPHQL_ENDPOINT,
    dsn: null,
    config: {},
    ...overrides,
  } as unknown as ConnectorView;
}

export interface CapturedGraphqlRequest {
  url: URL;
  init: RequestInit;
  headers: Headers;
  body: { query?: string; variables?: unknown };
}

export function recordingFetch(
  respond: (request: CapturedGraphqlRequest) => Response | Promise<Response>,
): {
  fetchImpl: typeof fetch;
  requests: CapturedGraphqlRequest[];
} {
  const requests: CapturedGraphqlRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const captured: CapturedGraphqlRequest = {
      url: new URL(String(input)),
      init: init ?? {},
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : {},
    };
    requests.push(captured);
    return respond(captured);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

export function asOrigin<T>(
  origin: "self_hosted" | "self_service",
  run: () => Promise<T>,
): Promise<T> {
  return _withEgressTenantOriginForTests(async () => origin, run);
}
