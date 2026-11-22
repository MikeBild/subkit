import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUBKIT_BIN = "./dist/subkit";
const SEMVER_OR_DEV = /^\d+\.\d+\.\d+(-\w+)?$/;
const built = existsSync(SUBKIT_BIN);

const STUB_SERVER = `
const tags = { new: "v99.0.0", old: "v0.0.1" };
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    const [, channel, releases, latest] = url.pathname.split("/");
    const tag = tags[channel];
    if (!tag || releases !== "releases" || latest !== "latest") return new Response("missing", { status: 404 });
    return new Response(null, { status: 302, headers: { location: url.origin + "/" + channel + "/releases/tag/" + tag } });
  },
});
console.log(server.port);
`;

let stub: ReturnType<typeof Bun.spawn> | null = null;
let base = "";
let home = "";

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "subkit-update-e2e-"));
  stub = Bun.spawn(["bun", "-e", STUB_SERVER], { stdout: "pipe", stderr: "inherit" });
  const reader = (stub.stdout as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  base = `http://127.0.0.1:${new TextDecoder().decode(value).trim()}`;
});

afterAll(() => {
  stub?.kill();
  rmSync(home, { recursive: true, force: true });
});

async function runBinary(
  args: string[],
  channel = "new",
): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn([SUBKIT_BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
      SUBKIT_RELEASES_URL: `${base}/${channel}/releases`,
    },
  });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout: stdout.trim() };
}

describe("binary version and self-update", () => {
  test("--version prints the build version", async () => {
    if (!built) return;
    const { stdout } = await runBinary(["--version"]);
    expect(stdout).toMatch(SEMVER_OR_DEV);
  });

  test("update --check reports a newer stub release without installing", async () => {
    if (!built) return;
    const { code, stdout } = await runBinary(["update", "--check"], "new");
    expect(code).toBe(0);
    expect(stdout).toContain("update available");
    expect(stdout).toContain("99.0.0");
  });

  test("update --check stays put when the stub release is not newer", async () => {
    if (!built) return;
    const { code, stdout } = await runBinary(["update", "--check"], "old");
    expect(code).toBe(0);
    expect(stdout).toContain("already at the latest version");
  });
});
