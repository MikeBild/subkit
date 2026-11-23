import { z } from "zod";
import type { DecryptedCredential } from "../../credentials/index.ts";
import type { ConnectorTemplate } from "../templates.ts";

export const CONTRACT_SECRETS = {
  token: "synthetic-contract-token",
  username: "synthetic-user",
  password: "synthetic-password",
  access_key_id: "SYNTHETICACCESSKEYID",
  secret_access_key: "synthetic-secret-access-key",
} as const;

const SYNTHETIC_HOST_RE = /(^|\.)example\.(com|org|net)$/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const DEFAULT_HEADER_NAME = "X-Api-Key";

const QuerySchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

const AuthHeaderSchema = z
  .object({
    name: z.string().min(1),
    value: z.string().min(1),
    match: z.enum(["exact", "prefix"]).default("exact"),
  })
  .strict();
export type ContractAuthHeader = z.infer<typeof AuthHeaderSchema>;

export const ExchangeContractSchema = z
  .object({
    request: z
      .object({
        base_url: z.string().url().optional(),
        method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
        path: z.string(),
        query: QuerySchema.optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.unknown().optional(),
      })
      .strict(),
    response: z
      .object({
        status: z.number().int().min(100).max(599),
        headers: z.record(z.string(), z.string()),
        body: z.unknown(),
      })
      .strict(),
    expect: z
      .object({
        url: z.string().url(),
        auth_header: AuthHeaderSchema.nullable(),
        output: z.unknown(),
      })
      .strict(),
  })
  .strict();
export type ExchangeContract = z.infer<typeof ExchangeContractSchema>;

export const SchemaContractSchema = z
  .object({
    connector: z
      .object({
        base_url: z.string().optional(),
        dsn: z.string().optional(),
        config: z.record(z.string(), z.unknown()),
      })
      .strict(),
    credential: z.record(z.string(), z.string()),
  })
  .strict();
export type SchemaContract = z.infer<typeof SchemaContractSchema>;

export type ContractFixture = ExchangeContract | SchemaContract;

export type ContractIssueCode =
  | "fixture_invalid"
  | "base_url_missing"
  | "base_url_unexpected"
  | "host_mismatch"
  | "request_invalid"
  | "probe_path_repeats_base"
  | "response_invalid"
  | "url_mismatch"
  | "auth_mismatch"
  | "secret_in_url"
  | "not_synthetic"
  | "credential_mismatch"
  | "request_count"
  | "host_escape"
  | "method_mismatch"
  | "auth_misplaced"
  | "secret_leak"
  | "body_mismatch"
  | "output_mismatch";

export interface ContractIssue {
  code: ContractIssueCode;
  message: string;
}

export interface ObservedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface ObservedExchange {
  requests: ObservedRequest[];
  output: unknown;
}

export function contractKind(driver: ConnectorTemplate["driver"]): "exchange" | "schema" {
  return driver === "http" || driver === "graphql" ? "exchange" : "schema";
}

function issue(code: ContractIssueCode, message: string): ContractIssue {
  return { code, message };
}

function hasPlaceholder(value: string): boolean {
  return /\{[A-Za-z0-9_]+\}/.test(value);
}

function fixedBaseUrl(template: ConnectorTemplate): string | null {
  const base = template.base_url;
  return base && !hasPlaceholder(base) ? base : null;
}

function placeholderPattern(base: string): RegExp {
  const escaped = base
    .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
    .replace(/\{[A-Za-z0-9_]+\}/g, "[A-Za-z0-9-]+");
  return new RegExp(`^${escaped}$`);
}

export function contractBaseUrl(
  template: ConnectorTemplate,
  fixture: ExchangeContract,
): string | null {
  return fixedBaseUrl(template) ?? fixture.request.base_url ?? null;
}

function baseUrlIssues(template: ConnectorTemplate, declared: string | undefined): ContractIssue[] {
  const fixed = fixedBaseUrl(template);
  if (fixed !== null) {
    return declared === undefined || declared === fixed
      ? []
      : [
          issue(
            "base_url_unexpected",
            `template "${template.slug}" has the fixed base_url ${fixed}; the fixture must not declare another one`,
          ),
        ];
  }
  if (declared === undefined) {
    return [
      issue(
        "base_url_missing",
        `template "${template.slug}" has no fixed base_url; the fixture must declare request.base_url`,
      ),
    ];
  }
  if (!declared.startsWith("https://")) {
    return [issue("host_mismatch", `base_url ${declared} must use https`)];
  }
  if (template.base_url) {
    return placeholderPattern(template.base_url).test(declared)
      ? []
      : [
          issue(
            "host_mismatch",
            `base_url ${declared} does not match the template base_url ${template.base_url}`,
          ),
        ];
  }
  if (template.url_pattern) {
    return new RegExp(template.url_pattern).test(declared)
      ? []
      : [
          issue(
            "host_mismatch",
            `base_url ${declared} does not match the template url_pattern ${template.url_pattern}`,
          ),
        ];
  }
  return SYNTHETIC_HOST_RE.test(new URL(declared).hostname)
    ? []
    : [
        issue(
          "host_mismatch",
          `template "${template.slug}" has no host of its own; base_url ${declared} must be under example.com`,
        ),
      ];
}

function declaredAuthParam(template: ConnectorTemplate): string | null {
  const option = template.auth_options.find((entry) => entry.auth_type === template.auth_type);
  if (option?.param_name) return option.param_name;
  return template.credential_hints.find((hint) => hint.header_name)?.header_name ?? null;
}

function basicValue(): string {
  const raw = `${CONTRACT_SECRETS.username}:${CONTRACT_SECRETS.password}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

export function expectedAuthHeader(
  template: ConnectorTemplate,
  declared: ContractAuthHeader | null,
): ContractAuthHeader | null {
  switch (template.auth_type) {
    case "none":
    case "query":
      return null;
    case "bearer":
    case "oauth2":
      return {
        name: "Authorization",
        value: `Bearer ${CONTRACT_SECRETS.token}`,
        match: "exact",
      };
    case "basic":
      return { name: "Authorization", value: basicValue(), match: "exact" };
    case "header":
      return {
        name: declaredAuthParam(template) ?? declared?.name ?? DEFAULT_HEADER_NAME,
        value: CONTRACT_SECRETS.token,
        match: "exact",
      };
    case "aws_sigv4":
      return {
        name: "Authorization",
        value: `AWS4-HMAC-SHA256 Credential=${CONTRACT_SECRETS.access_key_id}/`,
        match: "prefix",
      };
    case "signed_jwt":
      return { name: "Authorization", value: "Bearer eyJ", match: "prefix" };
  }
}

export function contractCredential(
  template: ConnectorTemplate,
  fixture: ExchangeContract,
  private_key?: string,
): DecryptedCredential | null {
  switch (template.auth_type) {
    case "none":
      return null;
    case "bearer":
      return { mode: "bearer", token: CONTRACT_SECRETS.token };
    case "oauth2":
      return {
        mode: "oauth2",
        access_token: CONTRACT_SECRETS.token,
        token_type: "Bearer",
        refresh_token: null,
        expires_at: null,
      };
    case "basic":
      return {
        mode: "basic",
        username: CONTRACT_SECRETS.username,
        password: CONTRACT_SECRETS.password,
      };
    case "header": {
      const name =
        expectedAuthHeader(template, fixture.expect.auth_header)?.name ?? DEFAULT_HEADER_NAME;
      return { mode: "header", headers: { [name]: CONTRACT_SECRETS.token } };
    }
    case "query":
      return {
        mode: "query",
        query: { [declaredAuthParam(template) ?? "api_key"]: CONTRACT_SECRETS.token },
      };
    case "aws_sigv4":
      return {
        mode: "aws_sigv4",
        access_key_id: CONTRACT_SECRETS.access_key_id,
        secret_access_key: CONTRACT_SECRETS.secret_access_key,
      };
    case "signed_jwt":
      return private_key ? { mode: "signed_jwt", private_key } : null;
  }
}

function contractSecretValues(credential: DecryptedCredential | null): string[] {
  if (!credential) return [];
  switch (credential.mode) {
    case "bearer":
      return [credential.token];
    case "oauth2":
      return [credential.access_token];
    case "basic":
      return [credential.password, basicValue().slice("Basic ".length)];
    case "header":
      return Object.values(credential.headers);
    case "query":
      return Object.values(credential.query);
    case "aws_sigv4":
      return [credential.secret_access_key];
    case "signed_jwt":
      return [credential.private_key];
    default:
      return [];
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function syntheticIssues(fixture: unknown): ContractIssue[] {
  const text = JSON.stringify(fixture) ?? "";
  const issues: ContractIssue[] = [];
  for (const match of text.matchAll(EMAIL_RE)) {
    const host = (match[1] ?? "").toLowerCase();
    if (!SYNTHETIC_HOST_RE.test(host)) {
      issues.push(
        issue("not_synthetic", `email address ${match[0]} must use an example.com address`),
      );
    }
  }
  return issues;
}

function sameAuthHeader(a: ContractAuthHeader | null, b: ContractAuthHeader | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.name.toLowerCase() === b.name.toLowerCase() && a.value === b.value && a.match === b.match
  );
}

function onConnectorHost(template: ConnectorTemplate, fixture: ExchangeContract): boolean {
  const base = contractBaseUrl(template, fixture);
  return base !== null && fixture.request.path.startsWith(`${base.replace(/\/+$/, "")}/`);
}

function pathSegments(path: string): string[] {
  return (
    path
      .split("?")[0]
      ?.split("/")
      .filter((segment) => segment !== "") ?? []
  );
}

function probeIssues(template: ConnectorTemplate): ContractIssue[] {
  const first = pathSegments(template.probe_endpoint?.path ?? "")[0];
  if (!template.base_url || first === undefined) return [];
  const basePath = template.base_url.replace(/^[a-z]+:\/\/[^/]+/i, "");
  return pathSegments(basePath).includes(first)
    ? [
        issue(
          "probe_path_repeats_base",
          `probe_endpoint.path ${template.probe_endpoint?.path} repeats "${first}" from the base_url ${template.base_url}`,
        ),
      ]
    : [];
}

function exchangeIssues(template: ConnectorTemplate, fixture: ExchangeContract): ContractIssue[] {
  const issues = baseUrlIssues(template, fixture.request.base_url);
  const { request, response, expect } = fixture;
  if (template.driver === "graphql") {
    const body = request.body as { query?: unknown } | null | undefined;
    if (request.method !== "POST" || request.path !== "" || typeof body?.query !== "string") {
      issues.push(
        issue(
          "request_invalid",
          'a GraphQL contract posts to the endpoint itself: method POST, path "" and body.query',
        ),
      );
    }
  } else if (!request.path.startsWith("/") && !onConnectorHost(template, fixture)) {
    issues.push(
      issue(
        "request_invalid",
        `request.path ${request.path} must start with "/" or be a URL under the connector base_url`,
      ),
    );
  }
  if (response.status < 200 || response.status > 299) {
    issues.push(
      issue("response_invalid", `response.status ${response.status} must be a success status`),
    );
  }
  const base = contractBaseUrl(template, fixture);
  if (base !== null && issues.length === 0) {
    const expected = new URL(expect.url);
    if (expected.origin !== new URL(base).origin) {
      issues.push(
        issue("url_mismatch", `expect.url ${expect.url} is not on the connector host ${base}`),
      );
    }
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (expected.searchParams.get(name) !== String(value)) {
        issues.push(issue("url_mismatch", `expect.url does not carry the query parameter ${name}`));
      }
    }
    const param = declaredAuthParam(template) ?? "api_key";
    const inUrl = expect.url.includes(CONTRACT_SECRETS.token);
    if (template.auth_type === "query") {
      if (expected.searchParams.get(param) !== CONTRACT_SECRETS.token) {
        issues.push(issue("auth_mismatch", `expect.url must carry the credential as ${param}`));
      }
    } else if (inUrl) {
      issues.push(issue("secret_in_url", "expect.url must not carry the credential"));
    }
  }
  const wanted = expectedAuthHeader(template, expect.auth_header);
  if (!sameAuthHeader(wanted, expect.auth_header)) {
    issues.push(
      issue(
        "auth_mismatch",
        wanted === null
          ? `auth_type ${template.auth_type} sends no auth header; expect.auth_header must be null`
          : `auth_type ${template.auth_type} expects ${wanted.name} to ${wanted.match === "prefix" ? "start with" : "equal"} "${wanted.value}"`,
      ),
    );
  }
  return issues;
}

function schemaIssues(template: ConnectorTemplate, fixture: SchemaContract): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const address = fixture.connector.dsn ?? fixture.connector.base_url ?? "";
  const matches = template.url_pattern
    ? new RegExp(template.url_pattern).test(address)
    : template.base_url
      ? address === template.base_url
      : address !== "";
  if (!matches) {
    issues.push(
      issue(
        "host_mismatch",
        `connector address "${address}" does not match template "${template.slug}"`,
      ),
    );
  }
  const wanted = template.credential_hints.map((hint) => hint.field).sort();
  const given = Object.keys(fixture.credential).sort();
  if (wanted.join(",") !== given.join(",")) {
    issues.push(
      issue(
        "credential_mismatch",
        `credential fields [${given.join(", ")}] differ from the template hints [${wanted.join(", ")}]`,
      ),
    );
  }
  for (const value of Object.values(fixture.credential)) {
    if (value !== "" && address.includes(value)) {
      issues.push(issue("secret_in_url", "the connector address must not carry a credential"));
    }
  }
  return issues;
}

function invalid(error: z.ZodError): ContractIssue[] {
  return error.issues.map((entry) =>
    issue("fixture_invalid", `${entry.path.join(".") || "fixture"}: ${entry.message}`),
  );
}

export function checkTemplateContract(
  template: ConnectorTemplate,
  fixture: unknown,
): ContractIssue[] {
  if (contractKind(template.driver) === "exchange") {
    const parsed = ExchangeContractSchema.safeParse(fixture);
    if (!parsed.success) return invalid(parsed.error);
    return [
      ...exchangeIssues(template, parsed.data),
      ...probeIssues(template),
      ...syntheticIssues(fixture),
    ];
  }
  const parsed = SchemaContractSchema.safeParse(fixture);
  if (!parsed.success) return invalid(parsed.error);
  return [...schemaIssues(template, parsed.data), ...syntheticIssues(fixture)];
}

function parseBody(body: string | null): unknown {
  if (body === null) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export function checkContractExchange(
  template: ConnectorTemplate,
  fixture: ExchangeContract,
  observed: ObservedExchange,
  credential: DecryptedCredential | null,
): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const base = contractBaseUrl(template, fixture);
  const home = base ? new URL(base).origin : null;
  for (const request of observed.requests) {
    if (new URL(request.url).origin !== home) {
      issues.push(issue("host_escape", `a request left the connector host: ${request.url}`));
    }
  }
  if (observed.requests.length !== 1) {
    issues.push(
      issue("request_count", `expected exactly one request, saw ${observed.requests.length}`),
    );
  }
  const sent = observed.requests[0];
  if (!sent) return issues;
  if (sent.url !== fixture.expect.url) {
    issues.push(issue("url_mismatch", `sent ${sent.url}, expected ${fixture.expect.url}`));
  }
  if (sent.method.toUpperCase() !== fixture.request.method) {
    issues.push(
      issue("method_mismatch", `sent ${sent.method}, expected ${fixture.request.method}`),
    );
  }
  const headers = Object.fromEntries(
    Object.entries(sent.headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const auth = fixture.expect.auth_header;
  const authName = auth?.name.toLowerCase() ?? null;
  if (auth === null || authName === null) {
    if (headers.authorization !== undefined) {
      issues.push(issue("auth_misplaced", "an Authorization header was sent but none is expected"));
    }
  } else {
    const value = headers[authName];
    const placed =
      value !== undefined &&
      (auth.match === "prefix" ? value.startsWith(auth.value) : value === auth.value);
    if (!placed) {
      issues.push(
        issue("auth_misplaced", `the credential was not placed in the ${auth.name} header`),
      );
    }
  }
  for (const secret of contractSecretValues(credential)) {
    if (credential?.mode !== "query" && sent.url.includes(secret)) {
      issues.push(issue("secret_leak", "the credential appears in the request URL"));
    }
    if (sent.body?.includes(secret)) {
      issues.push(issue("secret_leak", "the credential appears in the request body"));
    }
    for (const [name, value] of Object.entries(headers)) {
      if (name !== authName && value.includes(secret)) {
        issues.push(issue("secret_leak", `the credential appears in the ${name} header`));
      }
    }
  }
  if (fixture.request.body !== undefined && fixture.request.body !== null) {
    const same =
      template.driver === "graphql"
        ? sameJson(
            { variables: {}, ...(fixture.request.body as Record<string, unknown>) },
            parseBody(sent.body),
          )
        : typeof fixture.request.body === "string"
          ? fixture.request.body === sent.body
          : sameJson(fixture.request.body, parseBody(sent.body));
    if (!same) issues.push(issue("body_mismatch", "the request body differs from the fixture"));
  } else if (sent.body !== null && sent.body !== "") {
    issues.push(issue("body_mismatch", "a request body was sent but the fixture declares none"));
  }
  if (!sameJson(observed.output, fixture.expect.output)) {
    issues.push(issue("output_mismatch", "the driver output differs from expect.output"));
  }
  return issues;
}

function syntheticBaseUrl(template: ConnectorTemplate): string {
  if (template.base_url) return template.base_url.replace(/\{[A-Za-z0-9_]+\}/g, "synthetic");
  return `https://${template.slug}.example.com`;
}

function syntheticCredentialField(field: string): string {
  if (field === "username") return CONTRACT_SECRETS.username;
  if (field === "password") return CONTRACT_SECRETS.password;
  return CONTRACT_SECRETS.token;
}

const SCHEMA_DEFAULTS: Partial<
  Record<ConnectorTemplate["driver"], Pick<SchemaContract["connector"], "config" | "dsn">>
> = {
  postgres: { config: {}, dsn: "postgres://db.example.com:5432/synthetic" },
  s3: { config: { bucket: "synthetic-bucket" } },
  mcp: { config: { mcp: { transport: "http" } } },
};

export function scaffoldTemplateContract(template: ConnectorTemplate): ContractFixture {
  if (contractKind(template.driver) === "schema") {
    const defaults = SCHEMA_DEFAULTS[template.driver] ?? { config: {} };
    return {
      connector: {
        ...(defaults.dsn ? { dsn: defaults.dsn } : { base_url: syntheticBaseUrl(template) }),
        config: defaults.config,
      },
      credential: Object.fromEntries(
        template.credential_hints.map((hint) => [hint.field, syntheticCredentialField(hint.field)]),
      ),
    };
  }
  const fixed = fixedBaseUrl(template);
  const base = fixed ?? syntheticBaseUrl(template);
  const graphql = template.driver === "graphql";
  const path = graphql ? "" : template.probe_endpoint?.path || "/";
  const url = new URL(graphql ? base : `${base.replace(/\/+$/, "")}${path}`);
  if (template.auth_type === "query") {
    url.searchParams.set(declaredAuthParam(template) ?? "api_key", CONTRACT_SECRETS.token);
  }
  const body = graphql ? { data: { __typename: "Query" } } : { ok: true };
  return {
    request: {
      ...(fixed === null ? { base_url: base } : {}),
      method: graphql ? "POST" : "GET",
      path,
      ...(graphql ? { body: { query: "query Contract { __typename }" } } : {}),
    },
    response: { status: 200, headers: { "content-type": "application/json" }, body },
    expect: { url: url.toString(), auth_header: expectedAuthHeader(template, null), output: body },
  };
}
