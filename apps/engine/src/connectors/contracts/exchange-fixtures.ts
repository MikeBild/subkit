import { generateKeyPairSync } from "node:crypto";
import type { DecryptedCredential } from "../../credentials/types.ts";
import type { Db } from "../../db/client.ts";
import { withSelfHostedDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import {
  contractBaseUrl,
  contractCredential,
  type ExchangeContract,
  type ObservedExchange,
  type ObservedRequest,
} from "../core/contract.ts";
import { query as graphqlQuery } from "../drivers/graphql.ts";
import { executeConnectorHttpRequest } from "../drivers/http.ts";
import { enrichConnectorFromTemplate } from "../template-enrichment.ts";
import type { ConnectorTemplate } from "../templates.ts";
import type { ConnectorView } from "../types.ts";

const CONTRACT_TENANT = "00000000-0000-4000-8000-0000000000d1";
const CONTRACT_CONNECTOR = "00000000-0000-4000-8000-0000000000d2";
const unusedDb = {} as Db;

let privateKey: string | null = null;

function signingKey(): string {
  privateKey ??= generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  return privateKey;
}

export function contractExchangeCredential(
  template: ConnectorTemplate,
  fixture: ExchangeContract,
): DecryptedCredential | null {
  return contractCredential(
    template,
    fixture,
    template.auth_type === "signed_jwt" ? signingKey() : undefined,
  );
}

function contractConnector(template: ConnectorTemplate, fixture: ExchangeContract): ConnectorView {
  const enriched = enrichConnectorFromTemplate(
    { auth_type: template.auth_type, base_url: contractBaseUrl(template, fixture) },
    template,
  );
  const config = { ...(enriched.config ?? {}) };
  if (template.auth_type === "signed_jwt") {
    config.signed_jwt = {
      ...(config.signed_jwt as Record<string, unknown>),
      issuer: "synthetic-issuer",
      key_id: "SYNTHETICKEY",
    };
  }
  return {
    id: CONTRACT_CONNECTOR,
    tenant_id: CONTRACT_TENANT,
    slug: template.slug,
    driver: template.driver,
    environment: "dev",
    auth_type: template.auth_type,
    base_url: enriched.base_url ?? null,
    dsn: null,
    config,
    template_slug: template.slug,
    template_snapshot: null,
  } as unknown as ConnectorView;
}

function replyTo(fixture: ExchangeContract): Response {
  const { status, headers, body } = fixture.response;
  const text =
    body === undefined || body === null
      ? null
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  return new Response(text, { status, headers });
}

export async function observeContractExchange(
  template: ConnectorTemplate,
  fixture: ExchangeContract,
): Promise<ObservedExchange> {
  const requests: ObservedRequest[] = [];
  const fake = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = input instanceof Request ? input : null;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? request?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const raw = init?.body ?? null;
    requests.push({
      method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
      url: new URL(request ? request.url : String(input)).toString(),
      headers,
      body: raw === null ? null : typeof raw === "string" ? raw : String(raw),
    });
    return replyTo(fixture);
  }) as typeof fetch;
  const connector = contractConnector(template, fixture);
  const credential = contractExchangeCredential(template, fixture);
  const output = await withSelfHostedDriverFetchForTests(fake, async () => {
    if (template.driver === "graphql") {
      const body = fixture.request.body as { query: string; variables?: Record<string, unknown> };
      const result = await graphqlQuery({
        db: unusedDb,
        tenant_id: CONTRACT_TENANT,
        connector,
        query: body.query,
        ...(body.variables ? { variables: body.variables } : {}),
        ...(fixture.request.headers ? { extra_headers: fixture.request.headers } : {}),
        ...(credential ? { credential_override: credential } : {}),
      });
      return result.body;
    }
    const result = await executeConnectorHttpRequest({
      db: unusedDb,
      tenant_id: CONTRACT_TENANT,
      connector,
      method: fixture.request.method,
      path_or_url: fixture.request.path,
      ...(fixture.request.headers ? { headers: fixture.request.headers } : {}),
      ...(fixture.request.query ? { query: fixture.request.query } : {}),
      ...(fixture.request.body !== undefined ? { body: fixture.request.body } : {}),
      ...(credential ? { credential_override: credential } : {}),
    });
    return result.body;
  });
  return { requests, output };
}
