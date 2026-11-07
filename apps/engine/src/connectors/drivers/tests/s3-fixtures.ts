import type { Db } from "../../../db/client.ts";
import { withDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { _withEgressTenantOriginForTests } from "../../egress-guard.ts";
import type { ConnectorView } from "../../types.ts";

export const PUBLIC_ENDPOINT = "https://93.184.216.34";
export const TENANT = "00000000-0000-4000-8000-0000000000a1";
export const unusedDb = {} as Db;

export function s3Connector(
  config: Record<string, unknown>,
  overrides: Partial<ConnectorView> = {},
): ConnectorView {
  return {
    id: "00000000-0000-4000-8000-0000000000b1",
    tenant_id: TENANT,
    slug: "fixture-bucket",
    driver: "s3",
    environment: "dev",
    auth_type: "none",
    base_url: null,
    dsn: null,
    config: { endpoint: PUBLIC_ENDPOINT, bucket: "fixture", ...config },
    ...overrides,
  } as unknown as ConnectorView;
}

export const keyedConfig = { access_key_id: "AKIDFIXTURE", secret_access_key: "fixture-secret" };

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array | null;
}

export async function withStrictS3<T>(
  respond: (request: CapturedRequest) => Response,
  run: () => Promise<T>,
): Promise<{ result: T; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body;
    const captured: CapturedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: body instanceof ArrayBuffer ? new Uint8Array(body) : null,
    };
    requests.push(captured);
    return respond(captured);
  }) as unknown as typeof fetch;
  const result = await _withEgressTenantOriginForTests(
    async () => "self_service",
    () => withDriverFetchForTests(fetchImpl, run),
  );
  return { result, requests };
}

export function listXml(
  keys: readonly string[],
  options: { truncated?: boolean; next?: string } = {},
): Response {
  const contents = keys
    .map(
      (key) =>
        `<Contents><Key>${key}</Key><LastModified>2023-11-14T22:13:20.000Z</LastModified><ETag>"etag-${key}"</ETag><Size>${key.length}</Size></Contents>`,
    )
    .join("");
  const next = options.next ? `<NextContinuationToken>${options.next}</NextContinuationToken>` : "";
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>fixture</Name>${contents}<IsTruncated>${options.truncated === true}</IsTruncated>${next}</ListBucketResult>`,
    { status: 200, headers: { "content-type": "application/xml" } },
  );
}
