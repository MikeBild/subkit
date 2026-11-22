import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { runCommand } from "citty";
import type { PermissionListResponse } from "../engine-client/rbac.ts";
import { rbacCommand } from "./rbac.ts";

type Schemas = components["schemas"];

interface SeenRequest {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

const TENANT = "10000000-0000-4000-8000-000000000001";

const catalog: PermissionListResponse = {
  items: [
    {
      name: "workflows.read",
      description: "Read workflows",
      resource_type: "workflow",
      operator: false,
    },
    {
      name: "engine.admin",
      description: "Administer the engine",
      resource_type: "engine",
      operator: true,
    },
  ],
};

let previousFetch: typeof globalThis.fetch;
let previousWrite: typeof process.stdout.write;
let output: string[];
let paths: string[];
let requests: SeenRequest[];
let replies: Map<string, { status: number; body: unknown }>;

beforeEach(() => {
  previousFetch = globalThis.fetch;
  previousWrite = process.stdout.write.bind(process.stdout);
  output = [];
  paths = [];
  requests = [];
  replies = new Map();
  process.env.SUBKIT_ENGINE_URL = "https://engine.test/gateway";
  process.env.SUBKIT_API_KEY = "test-key";
  process.env.SUBKIT_TENANT = TENANT;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    paths.push(url.pathname);
    requests.push({
      method,
      path: url.pathname,
      search: url.search,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url.pathname === "/gateway/v1/rbac/permissions") {
      return new Response(JSON.stringify(catalog), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const reply = replies.get(`${method} ${url.pathname}`);
    if (reply) {
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  }) as typeof globalThis.fetch;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  globalThis.fetch = previousFetch;
  process.stdout.write = previousWrite;
  delete process.env.SUBKIT_ENGINE_URL;
  delete process.env.SUBKIT_API_KEY;
  delete process.env.SUBKIT_TENANT;
});

describe("subkit rbac permissions list", () => {
  test("renders one row per catalog entry with name, resource type, operator flag and description", async () => {
    await runCommand(rbacCommand, { rawArgs: ["permissions", "list"] });
    expect(output.join("")).toBe(
      [
        "name\tresource_type\toperator\tdescription",
        "workflows.read\tworkflow\tfalse\tRead workflows",
        "engine.admin\tengine\ttrue\tAdminister the engine",
        "",
      ].join("\n"),
    );
    expect(output.join("")).not.toContain("[object Object]");
    expect(paths).toEqual(["/gateway/v1/rbac/permissions"]);
  });

  test("passes the engine catalog entries through unchanged with --json", async () => {
    await runCommand(rbacCommand, { rawArgs: ["permissions", "list", "--json"] });
    expect(JSON.parse(output.join(""))).toEqual(catalog.items);
  });
});

const role: Schemas["RbacRoleDetail"] = {
  id: "20000000-0000-4000-8000-000000000001",
  tenant_id: TENANT,
  name: "ops",
  description: null,
  is_builtin: false,
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
  permissions: ["workflows.read"],
  member_count: 2,
};

const grant: Schemas["RbacGrant"] = {
  id: "30000000-0000-4000-8000-000000000001",
  tenant_id: TENANT,
  subject_type: "group",
  subject_id: "40000000-0000-4000-8000-000000000001",
  resource_type: "connector",
  resource_id: "50000000-0000-4000-8000-000000000001",
  permission_id: "60000000-0000-4000-8000-000000000001",
  permission: "connectors.read",
  granted_by: null,
  created_at: "2026-11-02T00:00:00.000Z",
  expires_at: null,
};

const hook: Schemas["RequestHook"] = {
  id: "70000000-0000-4000-8000-000000000001",
  tenant_id: TENANT,
  role: "member",
  source: "export default () => ({ allow: true });",
  description: "allow members",
  version: 3,
  enabled: true,
  created_at: "2026-11-03T00:00:00.000Z",
  updated_at: "2026-11-03T00:00:00.000Z",
};

describe("subkit rbac roles", () => {
  test("list sends no query string, the roles route declares none", async () => {
    replies.set("GET /gateway/v1/rbac/roles", {
      status: 200,
      body: { items: [role] } satisfies Schemas["RbacRoleListResponse"],
    });
    await runCommand(rbacCommand, { rawArgs: ["roles", "list"] });
    expect(requests.map((r) => `${r.method} ${r.path}${r.search}`)).toEqual([
      "GET /gateway/v1/rbac/roles",
    ]);
    expect(output.join("")).toBe(
      ["id\tname\tdescription\tcreated_at", `${role.id}\tops\t\t2026-11-01T00:00:00.000Z`, ""].join(
        "\n",
      ),
    );
  });

  test("create without --description sends only the name", async () => {
    replies.set("POST /gateway/v1/rbac/roles", { status: 201, body: role });
    await runCommand(rbacCommand, { rawArgs: ["roles", "create", "ops"] });
    expect(requests[0]?.body).toEqual({ name: "ops" } satisfies Schemas["CreateRbacRoleRequest"]);
  });
});

describe("subkit rbac grants", () => {
  test("list renders the subject and resource columns the grant contract carries", async () => {
    replies.set("GET /gateway/v1/rbac/grants", {
      status: 200,
      body: { items: [grant] } satisfies Schemas["RbacGrantListResponse"],
    });
    await runCommand(rbacCommand, { rawArgs: ["grants", "list"] });
    expect(requests.map((r) => `${r.path}${r.search}`)).toEqual(["/gateway/v1/rbac/grants"]);
    expect(output.join("")).toBe(
      [
        "id\tsubject_type\tsubject_id\tresource_type\tresource_id\tpermission\tcreated_at",
        `${grant.id}\tgroup\t${grant.subject_id}\tconnector\t${grant.resource_id}\tconnectors.read\t2026-11-02T00:00:00.000Z`,
        "",
      ].join("\n"),
    );
  });

  test("create sends the contract body with a typed subject", async () => {
    replies.set("POST /gateway/v1/rbac/grants", { status: 201, body: grant });
    await runCommand(rbacCommand, {
      rawArgs: [
        "grants",
        "create",
        "--subject",
        `group:${grant.subject_id}`,
        "--resource",
        `connector:${grant.resource_id}`,
        "--permission",
        "connectors.read",
      ],
    });
    expect(requests[0]?.body).toEqual({
      subject_type: "group",
      subject_id: grant.subject_id,
      resource_type: "connector",
      resource_id: grant.resource_id,
      permission: "connectors.read",
    } satisfies Schemas["CreateRbacGrantRequest"]);
  });

  test("create rejects a subject type outside the contract before any request", async () => {
    const errors: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    try {
      await expect(
        runCommand(rbacCommand, {
          rawArgs: [
            "grants",
            "create",
            "--subject",
            "team:t-1",
            "--resource",
            "connector:c-1",
            "--permission",
            "connectors.read",
          ],
        }),
      ).rejects.toThrow("--subject type must be one of user|system_account|group");
    } finally {
      stderr.mockRestore();
    }
    expect(requests).toEqual([]);
    expect(errors.join("")).toContain("--subject type must be one of user|system_account|group");
  });
});

describe("subkit rbac request-hooks", () => {
  test("list renders the hook contract columns", async () => {
    replies.set("GET /gateway/v1/auth/request-hooks", {
      status: 200,
      body: { items: [hook] } satisfies Schemas["RequestHookListResponse"],
    });
    await runCommand(rbacCommand, { rawArgs: ["request-hooks", "list"] });
    expect(output.join("")).toBe(
      [
        "id\trole\tversion\tenabled\tdescription",
        `${hook.id}\tmember\t3\ttrue\tallow members`,
        "",
      ].join("\n"),
    );
  });

  test("create sends role and the hook source read from --file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subkit-request-hook-"));
    const file = join(dir, "hook.ts");
    writeFileSync(file, hook.source);
    replies.set("POST /gateway/v1/auth/request-hooks", { status: 201, body: hook });
    try {
      await runCommand(rbacCommand, {
        rawArgs: [
          "request-hooks",
          "create",
          "--role",
          "member",
          "--file",
          file,
          "--description",
          "allow members",
          "--disabled",
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(requests[0]?.body).toEqual({
      role: "member",
      code: hook.source,
      description: "allow members",
      enabled: false,
    } satisfies Schemas["CreateRequestHookBody"]);
    expect(JSON.parse(output.join(""))).toEqual(hook);
  });
});

describe("subkit rbac whatcan", () => {
  test("asks for the connector resource type the permissions route accepts", async () => {
    const effective: Schemas["EffectivePermissions"] = {
      resource_type: "connector",
      resource_id: "c-1",
      level: "read-only",
      credential_scopes: null,
    };
    replies.set("GET /gateway/v1/identity/permissions", { status: 200, body: effective });
    await runCommand(rbacCommand, { rawArgs: ["whatcan", "c-1"] });
    expect(requests.map((r) => r.search)).toEqual(["?resource_type=connector&resource_id=c-1"]);
    expect(output.join("")).toBe("connector c-1: read-only\n");
  });
});
