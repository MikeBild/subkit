import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const ENGINE_ENTRY = join(import.meta.dir, "..", "..", "index.ts");

let ctx: HttpTestServer;
let keyDir = "";

beforeAll(async () => {
  ctx = await createHttpTestServer("token-exchange-cli");
  keyDir = mkdtempSync(join(tmpdir(), "subkit-tx-cli-"));
});

afterAll(async () => {
  rmSync(keyDir, { recursive: true, force: true });
  await ctx.cleanup();
});

async function runCli(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", ENGINE_ENTRY, "--token-exchange", ...args], {
    env: {
      ...process.env,
      DATABASE_URL: ctx.testDb.url,
      SUBKIT_CONFIG: join(keyDir, "subkit.config.json"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("engine --token-exchange", () => {
  test("prints a token the engine accepts; scope and ttl are honoured", async () => {
    const keyFile = join(keyDir, "api-key");
    writeFileSync(keyFile, `${ctx.apiKey}\n`, { mode: 0o600 });

    const run = await runCli(["--key-file", keyFile, "--scope", "workflows:read", "--ttl", "300"]);
    expect(run.stderr).not.toContain(ctx.apiKey);
    expect(run.code).toBe(0);
    expect(run.stdout.trim().split("\n")).toHaveLength(1);
    const token = run.stdout.trim();
    expect(token.split(".")).toHaveLength(3);
    expect(token).not.toContain(ctx.apiKey);

    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    expect(claims.scope).toBe("workflows:read");
    expect(claims.exp - claims.iat).toBe(300);

    const me = await fetch(`${ctx.baseUrl}/v1/identity/whoami`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { id: string; scopes: string[] };
    expect(body.id).toBe(ctx.userId);
    expect(body.scopes).toEqual(["workflows:read"]);
  }, 60_000);

  test("exits 1 with the OAuth error on a key the engine refuses", async () => {
    const keyFile = join(keyDir, "bad-key");
    writeFileSync(keyFile, "wf_live_notaknownkey00000000000000000\n");
    const run = await runCli(["--key-file", keyFile]);
    expect(run.code).toBe(1);
    expect(run.stdout.trim()).toBe("");
    expect(run.stderr).toContain("invalid_grant");
  }, 60_000);

  test("refuses to run without --key-file (the key is never an argument)", async () => {
    const run = await runCli([]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("--key-file");
  }, 60_000);
});
