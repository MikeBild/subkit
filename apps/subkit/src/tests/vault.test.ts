import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { credentialBody } from "../commands/vault.ts";
import type { CredentialBody } from "../engine-client/connectors.ts";

const TENANT_ID = "5eed0001-0000-4000-8000-000000000001";
const CONNECTOR_ID = "5eed0003-0000-4000-8000-000000000001";
const CREDENTIAL_ID = "5eed0005-0000-4000-8000-000000000001";
const VAULT_ID = "5eed0007-0000-4000-8000-000000000001";
const VAULT_ITEM = {
  id: VAULT_ID,
  name: "crm-token",
  kind: "secret",
  scope: "workspace",
  environment: "prod",
  description: null,
  version: 1,
  connector: null,
  template_slug: null,
  fields: ["token"],
  created_at: "2026-11-21T00:00:00.000Z",
  updated_at: "2026-11-21T00:00:00.000Z",
  rotated_at: null,
  last_used_at: null,
};

describe("credentialBody builds the contract CredentialBody per mode", () => {
  test.each<[string, Parameters<typeof credentialBody>[0], CredentialBody]>([
    ["bearer", { mode: "bearer", value: "t0k" }, { mode: "bearer", token: "t0k" }],
    [
      "signed_jwt",
      { mode: "signed_jwt", value: "PEM" },
      { mode: "signed_jwt", private_key: "PEM" },
    ],
    [
      "header",
      { mode: "header", header: "X-Api-Key", value: "abc" },
      { mode: "header", headers: { "X-Api-Key": "abc" } },
    ],
    ["query", { mode: "query", query: "key", value: "v" }, { mode: "query", query: { key: "v" } }],
    [
      "header lines",
      { mode: "header", value: "Authorization=Bearer a=b\r\napikey = k\n\nnoise" },
      { mode: "header", headers: { Authorization: "Bearer a=b", apikey: " k" } },
    ],
    [
      "basic",
      { mode: "basic", username: "u", value: "p" },
      { mode: "basic", username: "u", password: "p" },
    ],
    [
      "aws_sigv4",
      { mode: "aws_sigv4", accessKeyId: "AK", value: "SK\nST" },
      { mode: "aws_sigv4", access_key_id: "AK", secret_access_key: "SK", session_token: "ST" },
    ],
    [
      "aws_sigv4 without session",
      { mode: "aws_sigv4", accessKeyId: "AK", value: "SK" },
      { mode: "aws_sigv4", access_key_id: "AK", secret_access_key: "SK" },
    ],
    ["none", { mode: "none" }, { mode: "none" }],
  ])("%s", (_name, args, expected) => {
    expect(credentialBody(args)).toEqual(expected);
  });

  test.each<[Parameters<typeof credentialBody>[0], string]>([
    [{ mode: "bearer" }, "bearer mode reads its secret from stdin or a hidden prompt"],
    [{ mode: "signed_jwt", value: "" }, "signed_jwt mode reads its secret from stdin"],
    [{ mode: "header", value: "v" }, "write one Name=Value line per entry"],
    [{ mode: "query", value: "=v" }, "write one Name=Value line per entry"],
    [{ mode: "basic", value: "p" }, "basic mode requires --username"],
    [{ mode: "aws_sigv4", value: "SK" }, "aws_sigv4 mode requires --access-key-id"],
    [{ mode: "aws_sigv4", accessKeyId: "AK", value: "\nST" }, "aws_sigv4 mode reads its secret"],
    [{ mode: "oauth2", value: "x" }, "unknown --mode 'oauth2'"],
  ])("rejects %o", (args, message) => {
    expect(() => credentialBody(args)).toThrow(message);
  });
});

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

let server: ReturnType<typeof Bun.serve>;
let seen: Seen[] = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = request.method === "GET" ? "" : await request.text();
      seen.push({
        method: request.method,
        path: url.pathname,
        body: text ? JSON.parse(text) : undefined,
      });
      const route = `${request.method} ${url.pathname}`;
      if (route === `POST /v1/connectors/${CONNECTOR_ID}/credentials`)
        return Response.json({ id: CREDENTIAL_ID }, { status: 201 });
      if (route === `POST /v1/vault/${CREDENTIAL_ID}/refresh`)
        return Response.json({
          id: CREDENTIAL_ID,
          tenant_id: TENANT_ID,
          connector_id: CONNECTOR_ID,
          environment: "dev",
          mode: "bearer",
          oauth2_expires_at: null,
          updated_at: "2026-11-06T00:00:00.000Z",
        });
      if (route === "POST /v1/vault")
        return Response.json({ ...VAULT_ITEM, ...(text ? JSON.parse(text) : {}) }, { status: 201 });
      if (route === "GET /v1/vault") return Response.json({ items: [VAULT_ITEM] });
      if (route === `POST /v1/vault/${VAULT_ID}/reveal`)
        return Response.json({ id: VAULT_ID, name: "crm-token", values: { token: "piped" } });
      return Response.json({ code: "not_found", message: "no route" }, { status: 404 });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

async function subkit(args: string[], stdin?: string) {
  seen = [];
  const commandPath = new URL("../commands/vault.ts", import.meta.url).pathname;
  const script = `import { runCommand } from "citty"; import { vaultCommand } from ${JSON.stringify(commandPath)}; await runCommand(vaultCommand, { rawArgs: ${JSON.stringify(args)} });`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      SUBKIT_ENGINE_URL: `http://127.0.0.1:${server.port}`,
      SUBKIT_API_KEY: "synthetic-cli-key",
      SUBKIT_TENANT: TENANT_ID,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { exitCode, stdout, seen };
}

describe("subkit vault request bodies match the engine contract", () => {
  test("attach reads the secret from stdin, posts CredentialBody and prints the created id", async () => {
    const run = await subkit(
      ["attach", CONNECTOR_ID, "--mode", "bearer", "--skip-checks", "--json"],
      "t0k\n",
    );
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      {
        method: "POST",
        path: `/v1/connectors/${CONNECTOR_ID}/credentials`,
        body: { mode: "bearer", token: "t0k" } satisfies CredentialBody,
      },
    ]);
    expect(JSON.parse(run.stdout)).toEqual({ id: CREDENTIAL_ID });
  });

  test("attach no longer takes a value flag", async () => {
    const run = await subkit(
      [
        "attach",
        CONNECTOR_ID,
        "--mode",
        "header",
        "--header",
        "X-Api-Key",
        "--skip-checks",
        "--json",
      ],
      "header-secret",
    );
    expect(run.seen[0]?.body).toEqual({
      mode: "header",
      headers: { "X-Api-Key": "header-secret" },
    });
  });

  test("refresh posts the empty contract body", async () => {
    const run = await subkit(["refresh", CREDENTIAL_ID]);
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      { method: "POST", path: `/v1/vault/${CREDENTIAL_ID}/refresh`, body: {} },
    ]);
    expect(run.stdout).toBe("refreshed\n");
  });

  test("add reads the value from stdin and never from arguments", async () => {
    const run = await subkit(["add", "crm-token", "--env", "dev", "--json"], "piped-secret\n");
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      {
        method: "POST",
        path: "/v1/vault",
        body: {
          kind: "secret",
          name: "crm-token",
          scope: "workspace",
          environment: "dev",
          token: "piped-secret",
        },
      },
    ]);
  });

  test("list prints names and metadata only", async () => {
    const run = await subkit(["list", "--json"]);
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      {
        id: VAULT_ID,
        name: "crm-token",
        kind: "secret",
        scope: "workspace",
        environment: "prod",
        version: 1,
        connector: "",
        last_used_at: "",
      },
    ]);
  });

  test("reveal needs --yes and then prints the requested field", async () => {
    const refused = await subkit(["reveal", VAULT_ID]);
    expect(refused.seen).toEqual([]);
    expect(refused.stdout).not.toContain("piped");
    const run = await subkit(["reveal", VAULT_ID, "--field", "token", "--yes"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("piped\n");
  });
});
