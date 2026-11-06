import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { credentialBody } from "../commands/credentials.ts";
import type { CredentialBody } from "../engine-client/connectors.ts";

const TENANT_ID = "5eed0001-0000-4000-8000-000000000001";
const CONNECTOR_ID = "5eed0003-0000-4000-8000-000000000001";
const CREDENTIAL_ID = "5eed0005-0000-4000-8000-000000000001";

describe("credentialBody builds the contract CredentialBody per mode", () => {
  test.each<[string, Parameters<typeof credentialBody>[0], CredentialBody]>([
    ["bearer", { mode: "bearer", token: "t0k" }, { mode: "bearer", token: "t0k" }],
    [
      "signed_jwt",
      { mode: "signed_jwt", privateKey: "PEM" },
      { mode: "signed_jwt", private_key: "PEM" },
    ],
    [
      "header",
      { mode: "header", header: "X-Api-Key=abc, X-Org:o1" },
      { mode: "header", headers: { "X-Api-Key": "abc", "X-Org": "o1" } },
    ],
    ["query", { mode: "query", query: "key=v" }, { mode: "query", query: { key: "v" } }],
    [
      "basic",
      { mode: "basic", username: "u", password: "p" },
      { mode: "basic", username: "u", password: "p" },
    ],
    [
      "aws_sigv4",
      { mode: "aws_sigv4", accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" },
      { mode: "aws_sigv4", access_key_id: "AK", secret_access_key: "SK", session_token: "ST" },
    ],
    [
      "aws_sigv4 without session",
      { mode: "aws_sigv4", accessKeyId: "AK", secretAccessKey: "SK" },
      { mode: "aws_sigv4", access_key_id: "AK", secret_access_key: "SK" },
    ],
    ["none", { mode: "none" }, { mode: "none" }],
  ])("%s", (_name, args, expected) => {
    expect(credentialBody(args)).toEqual(expected);
  });

  test.each<[Parameters<typeof credentialBody>[0], string]>([
    [{ mode: "bearer" }, "bearer mode requires --token"],
    [{ mode: "signed_jwt" }, "signed_jwt requires --private-key-file"],
    [{ mode: "header" }, 'header mode requires --header "Name=Value"'],
    [{ mode: "query" }, 'query mode requires --query "key=Value"'],
    [{ mode: "basic", username: "u" }, "basic mode requires --username and --password"],
    [
      { mode: "aws_sigv4", accessKeyId: "AK" },
      "aws_sigv4 mode requires --access-key-id and --secret-access-key",
    ],
    [{ mode: "oauth2" }, "unknown --mode 'oauth2'"],
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
      if (route === `POST /v1/credentials/${CREDENTIAL_ID}/rotate`)
        return Response.json({
          id: CREDENTIAL_ID,
          tenant_id: TENANT_ID,
          connector_id: CONNECTOR_ID,
          environment: "dev",
          mode: "bearer",
          oauth2_expires_at: null,
          updated_at: "2026-11-06T00:00:00.000Z",
        });
      return Response.json({ code: "not_found", message: "no route" }, { status: 404 });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

async function sk(args: string[]) {
  seen = [];
  const commandPath = new URL("../commands/credentials.ts", import.meta.url).pathname;
  const script = `import { runCommand } from "citty"; import { credentialsCommand } from ${JSON.stringify(commandPath)}; await runCommand(credentialsCommand, { rawArgs: ${JSON.stringify(args)} });`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      SUBKIT_ENGINE_URL: `http://127.0.0.1:${server.port}`,
      SUBKIT_API_KEY: "synthetic-cli-key",
      SUBKIT_TENANT: TENANT_ID,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { exitCode, stdout, seen };
}

describe("sk credentials request bodies match the engine contract", () => {
  test("set posts CredentialBody and prints the created id", async () => {
    const run = await sk([
      "set",
      CONNECTOR_ID,
      "--mode",
      "bearer",
      "--token",
      "t0k",
      "--skip-checks",
      "--json",
    ]);
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

  test("rotate posts the empty contract body", async () => {
    const run = await sk(["rotate", CREDENTIAL_ID]);
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      { method: "POST", path: `/v1/credentials/${CREDENTIAL_ID}/rotate`, body: {} },
    ]);
    expect(run.stdout).toBe("rotated\n");
  });
});
