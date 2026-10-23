import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, "..", "index.ts");
const requests: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "sk-leading-options-"));
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push(`${req.method} ${url.pathname}`);
      if (req.method === "GET" && url.pathname === "/v1/settings/llm.provider") {
        return Response.json({
          path: "llm.provider",
          value: "openai",
          meta: { source: "global", scope: "tenant", sensitive: false, kind: "enum" },
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

async function sk(args: string[]) {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    env: { ...process.env, HOME: home, NO_COLOR: "1", SUBKIT_ENGINE_URL: "", SUBKIT_API_KEY: "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, exitCode };
}

describe("sk with options before the subcommand", () => {
  test("applies the options to the subcommand and never starts a conversation", async () => {
    requests.length = 0;
    const engineUrl = `http://127.0.0.1:${server.port}`;
    const r = await sk([
      "--engine-url",
      engineUrl,
      "--api-key",
      "sk_test",
      "settings",
      "get",
      "llm.provider",
      "--json",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('"openai"');
    expect(requests).toContain("GET /v1/settings/llm.provider");
    expect(requests.some((line) => line.includes("/conversations"))).toBe(false);
  }, 30_000);
});
