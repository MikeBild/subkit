import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { runCommand } from "citty";
import { EngineClient, type FetchLike } from "../../engine-client.ts";
import { apiKeysCommand } from "../apikeys.ts";
import { portalTokensCommand } from "../portal-tokens.ts";
import { systemAccountsCommand } from "../system-accounts.ts";
import { usersCommand } from "../users.ts";

type Schemas = components["schemas"];

interface SeenRequest {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

const TENANT = "10000000-0000-4000-8000-000000000001";
const USER = "11111111-1111-4111-8111-111111111111";

let previousFetch: typeof globalThis.fetch;
let output: string[];
let errors: string[];
let requests: SeenRequest[];
let replies: Map<string, { status: number; body: unknown }>;
const restorers: Array<{ mockRestore(): void }> = [];

function reply(method: string, path: string, status: number, body: unknown): void {
  replies.set(`${method} /gateway${path}`, { status, body });
}

beforeEach(() => {
  previousFetch = globalThis.fetch;
  output = [];
  errors = [];
  requests = [];
  replies = new Map();
  process.env.SUBKIT_ENGINE_URL = "https://engine.test/gateway";
  process.env.SUBKIT_API_KEY = "test-key";
  process.env.SUBKIT_TENANT = TENANT;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    requests.push({
      method,
      path: url.pathname,
      search: url.search,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const hit = replies.get(`${method} ${url.pathname}`);
    if (!hit) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return new Response(JSON.stringify(hit.body), {
      status: hit.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  restorers.push(
    spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    }),
    spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    }),
  );
});

afterEach(() => {
  for (const r of restorers.splice(0)) r.mockRestore();
  globalThis.fetch = previousFetch;
  delete process.env.SUBKIT_ENGINE_URL;
  delete process.env.SUBKIT_API_KEY;
  delete process.env.SUBKIT_TENANT;
});

const portalToken: Schemas["PortalToken"] = {
  id: "80000000-0000-4000-8000-000000000001",
  tenant_id: TENANT,
  enduser_ref: USER,
  prefix: "pt_abcd",
  allowed_workflows: ["wf-1"],
  expires_at: "2026-11-06T01:00:00.000Z",
  revoked_at: null,
  created_at: "2026-11-06T00:00:00.000Z",
};

const apiKey: Schemas["ApiKey"] = {
  id: "90000000-0000-4000-8000-000000000001",
  tenant_id: TENANT,
  prefix: "sk_abcd",
  name: "ci",
  scopes: ["*"],
  user_id: USER,
  system_account_id: null,
  creator: { kind: "user", id: USER },
  allowed_workflows: null,
  allowed_connectors: null,
  created_at: "2026-11-05T00:00:00.000Z",
  last_used_at: null,
  expires_at: null,
  rotating_out_at: null,
  rotated_from_id: null,
  revoked_at: null,
};

const whoami: Schemas["Whoami"] = {
  id: USER,
  kind: "user",
  tenant_id: TENANT,
  tenant_slug: "acme",
  email: "a@example.com",
  role_name: "admin",
  provider: "api_key",
  base_url: null,
  scopes: null,
  product_id: null,
  engine_operator: false,
};

const user: Schemas["User"] = {
  id: USER,
  tenant_id: TENANT,
  email: "a@example.com",
  display_name: null,
  role: "member",
  status: "active",
  oauth_connections: 0,
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
};

describe("sk portal-tokens", () => {
  test("create sends user_id, allowed_workflows and ttl_minutes from the contract", async () => {
    reply("POST", "/v1/identity/portal-tokens", 201, {
      ...portalToken,
      plaintext_token: "pt_abcd_secret",
    } satisfies Schemas["PortalTokenIssued"]);
    await runCommand(portalTokensCommand, {
      rawArgs: ["create", "--user-id", USER, "--workflows", "wf-1, wf-2", "--ttl", "30"],
    });
    expect(requests[0]?.body).toEqual({
      user_id: USER,
      allowed_workflows: ["wf-1", "wf-2"],
      ttl_minutes: 30,
    } satisfies Schemas["IssuePortalTokenBody"]);
    expect(JSON.parse(output.join("")).plaintext_token).toBe("pt_abcd_secret");
  });

  test("create without workflows fails before any request", async () => {
    await expect(
      runCommand(portalTokensCommand, {
        rawArgs: ["create", "--user-id", USER, "--workflows", " , "],
      }),
    ).rejects.toThrow("--workflows must name at least one workflow id");
    expect(requests).toEqual([]);
  });

  test("create rejects a ttl that is not a positive integer", async () => {
    await expect(
      runCommand(portalTokensCommand, {
        rawArgs: ["create", "--user-id", USER, "--workflows", "wf-1", "--ttl", "0"],
      }),
    ).rejects.toThrow("--ttl must be a positive integer (minutes)");
    expect(requests).toEqual([]);
  });

  test("list renders the portal token contract columns", async () => {
    reply("GET", "/v1/identity/portal-tokens", 200, {
      items: [portalToken],
    } satisfies Schemas["PortalTokenListResponse"]);
    await runCommand(portalTokensCommand, { rawArgs: ["list"] });
    expect(output.join("")).toBe(
      [
        "id\tenduser_ref\tprefix\tcreated_at\texpires_at",
        `${portalToken.id}\t${USER}\tpt_abcd\t2026-11-06T00:00:00.000Z\t2026-11-06T01:00:00.000Z`,
        "",
      ].join("\n"),
    );
  });
});

describe("sk apikeys", () => {
  test("create issues the key for the caller with the contract body", async () => {
    reply("GET", "/v1/identity/whoami", 200, whoami);
    reply("POST", "/v1/identity/api-keys", 201, {
      ...apiKey,
      plaintext_key: "sk_abcd_secret",
    } satisfies Schemas["ApiKeyIssued"]);
    await runCommand(apiKeysCommand, {
      rawArgs: ["create", "--name", "ci", "--scopes", "workflow:read,workflow:run"],
    });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /gateway/v1/identity/whoami",
      "POST /gateway/v1/identity/api-keys",
    ]);
    expect(requests[1]?.body).toEqual({
      owner_kind: "user",
      owner_id: USER,
      name: "ci",
      scopes: ["workflow:read", "workflow:run"],
    } satisfies Schemas["IssueApiKeyBody"]);
  });

  test("list keeps its columns", async () => {
    reply("GET", "/v1/identity/api-keys", 200, {
      items: [apiKey],
    } satisfies Schemas["ApiKeyListResponse"]);
    await runCommand(apiKeysCommand, { rawArgs: ["list"] });
    expect(output.join("")).toBe(
      [
        "id\tname\tprefix\tcreated_at\texpires_at",
        `${apiKey.id}\tci\tsk_abcd\t2026-11-05T00:00:00.000Z\t`,
        "",
      ].join("\n"),
    );
  });
});

describe("sk system-accounts", () => {
  test("create sends the contract body", async () => {
    const account: Schemas["SystemAccount"] = {
      id: "a0000000-0000-4000-8000-000000000001",
      tenant_id: TENANT,
      name: "ci-deployer",
      description: null,
      created_at: "2026-11-04T00:00:00.000Z",
      updated_at: "2026-11-04T00:00:00.000Z",
    };
    reply("POST", "/v1/identity/system-accounts", 201, account);
    await runCommand(systemAccountsCommand, { rawArgs: ["create", "--name", "ci-deployer"] });
    expect(requests[0]?.body).toEqual({
      name: "ci-deployer",
    } satisfies Schemas["CreateSystemAccountBody"]);
    expect(JSON.parse(output.join(""))).toEqual(account);
  });
});

describe("sk users", () => {
  test("list sends limit and product_id as the contract query", async () => {
    reply("GET", "/v1/identity/users", 200, { items: [], total: 0 });
    await runCommand(usersCommand, { rawArgs: ["list", "--limit", "5", "--app", "portal"] });
    expect(requests.map((r) => r.search)).toEqual(["?limit=5&product_id=portal"]);
  });

  test("patch sends the role as the contract body", async () => {
    reply("PATCH", `/v1/identity/users/${USER}`, 200, { ...user, role: "admin" });
    await runCommand(usersCommand, { rawArgs: ["patch", USER, "--role", "admin"] });
    expect(requests[0]?.body).toEqual({ role: "admin" } satisfies Schemas["UpdateUserBody"]);
  });
});

describe("EngineClient identity tenants", () => {
  test("lists tenants without a query string, the route declares none", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ items: [] } satisfies Schemas["TenantListResponse"]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new EngineClient({ engine_url: "http://engine.test", api_key: "k", fetchImpl });
    expect(await client.listIdentityTenants()).toEqual({ items: [] });
    expect(urls).toEqual(["http://engine.test/v1/identity/tenants"]);
  });
});
