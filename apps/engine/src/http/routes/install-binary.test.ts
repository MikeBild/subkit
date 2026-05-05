// install-binary route — unit + handler tests against a tmpdir bundle.
//
// Every test points SUBKIT_BINARIES_DIR at a freshly-mkdtemp'd directory
// and clears the per-dir manifest cache so a stale parse from a previous
// test does not leak. Hono's `app.request()` is used in lieu of a
// running HTTP server — the install-binary route has no DB dependency,
// so the smaller surface keeps tests honest about what the route does
// and does not touch.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../openapi.ts";
import { _internal, registerInstallBinaryRoute } from "./install-binary.ts";

interface BundleFixture {
  dir: string;
  binaries: Record<string, Uint8Array>;
}

async function mkBundle(
  binaries: Record<string, Uint8Array>,
  opts: { writeSums?: boolean } = {},
): Promise<BundleFixture> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "subkit-install-binary-"));
  for (const [name, bytes] of Object.entries(binaries)) {
    await fs.writeFile(path.join(dir, name), bytes);
  }
  if (opts.writeSums !== false) {
    const lines = Object.entries(binaries).map(([name, bytes]) => {
      const sha = createHash("sha256").update(bytes).digest("hex");
      return `${sha}  ${name}`;
    });
    await fs.writeFile(path.join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
  }
  return { dir, binaries };
}

function buildApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  registerInstallBinaryRoute(app);
  return app;
}

let originalEnvDir: string | undefined;
let activeDir: string | null = null;

beforeEach(() => {
  originalEnvDir = process.env.SUBKIT_BINARIES_DIR;
  _internal.clearCache();
});

afterEach(async () => {
  if (originalEnvDir === undefined) {
    delete process.env.SUBKIT_BINARIES_DIR;
  } else {
    process.env.SUBKIT_BINARIES_DIR = originalEnvDir;
  }
  if (activeDir) {
    await fs.rm(activeDir, { recursive: true, force: true });
    activeDir = null;
  }
  _internal.clearCache();
});

describe("parseAsset", () => {
  test("accepts every shipping platform-arch combo for sk + agent", () => {
    const valid = [
      "sk-darwin-arm64",
      "sk-darwin-x64",
      "sk-linux-arm64",
      "sk-linux-x64",
      "sk-windows-x64",
      "agent-darwin-arm64",
      "agent-darwin-x64",
      "agent-linux-arm64",
      "agent-linux-x64",
      "agent-windows-x64",
    ];
    for (const asset of valid) {
      expect(_internal.parseAsset(asset)).not.toBeNull();
    }
  });

  test("rejects windows-arm64 (not produced by the release matrix)", () => {
    expect(_internal.parseAsset("sk-windows-arm64")).toBeNull();
    expect(_internal.parseAsset("agent-windows-arm64")).toBeNull();
  });

  test("rejects unknown kinds, platforms, archs, and malformed slugs", () => {
    const invalid = [
      "tunnel-agent-linux-x64", // wrong kind alias — URL uses `agent`, not `tunnel-agent`
      "engine-linux-x64", // engine is not served via /install
      "sk-windows-aarch64", // aarch64 alias only valid in the install-script side
      "sk_darwin_arm64", // underscore, not hyphen — disk shape, not URL shape
      "sk-darwin",
      "sk--arm64",
      "",
      "..%2Fetc%2Fpasswd",
    ];
    for (const asset of invalid) {
      expect(_internal.parseAsset(asset)).toBeNull();
    }
  });
});

describe("diskFilename", () => {
  test("maps sk → sk_, agent → tunnel-agent_, appends .exe on windows", () => {
    expect(_internal.diskFilename({ kind: "sk", platform: "darwin", arch: "arm64" })).toBe(
      "sk_darwin_arm64",
    );
    expect(_internal.diskFilename({ kind: "agent", platform: "linux", arch: "x64" })).toBe(
      "tunnel-agent_linux_x64",
    );
    expect(_internal.diskFilename({ kind: "sk", platform: "windows", arch: "x64" })).toBe(
      "sk_windows_x64.exe",
    );
    expect(_internal.diskFilename({ kind: "agent", platform: "windows", arch: "x64" })).toBe(
      "tunnel-agent_windows_x64.exe",
    );
  });
});

describe("GET /install/{asset} — bundled image", () => {
  test("streams sk binary with sha header + correct length", async () => {
    const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]); // ELF magic
    const fixture = await mkBundle({ sk_linux_x64: bytes });
    activeDir = fixture.dir;
    process.env.SUBKIT_BINARIES_DIR = fixture.dir;
    _internal.clearCache();

    const res = await buildApp().request("/install/sk-linux-x64");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="sk_linux_x64"');
    const expectedSha = createHash("sha256").update(bytes).digest("hex");
    expect(res.headers.get("x-subkit-sha256")).toBe(expectedSha);

    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBe(bytes.byteLength);
    const actualSha = createHash("sha256").update(body).digest("hex");
    expect(actualSha).toBe(expectedSha);
  });

  test("streams agent binary mapping URL `agent` → disk `tunnel-agent`", async () => {
    const bytes = new TextEncoder().encode("agent-bytes\n");
    const fixture = await mkBundle({ "tunnel-agent_darwin_arm64": bytes });
    activeDir = fixture.dir;
    process.env.SUBKIT_BINARIES_DIR = fixture.dir;
    _internal.clearCache();

    const res = await buildApp().request("/install/agent-darwin-arm64");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="tunnel-agent_darwin_arm64"',
    );
    const body = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(body)).toBe("agent-bytes\n");
  });

  test("HEAD request returns the same headers as GET (install-script probe contract)", async () => {
    // The install.ts script probes the engine with `curl -fsSI` (HEAD)
    // before downloading. Hono auto-handles HEAD on GET routes by
    // running the handler and stripping the body — pin that the
    // x-subkit-sha256 / content-length headers survive so the
    // probe-then-fetch flow works against a real engine.
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const fixture = await mkBundle({ sk_linux_x64: bytes });
    activeDir = fixture.dir;
    process.env.SUBKIT_BINARIES_DIR = fixture.dir;
    _internal.clearCache();

    const res = await buildApp().request("/install/sk-linux-x64", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-subkit-sha256")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
  });

  test("appends .exe on disk for windows targets but not in the URL", async () => {
    const bytes = new TextEncoder().encode("MZ-header-stub");
    const fixture = await mkBundle({ "sk_windows_x64.exe": bytes });
    activeDir = fixture.dir;
    process.env.SUBKIT_BINARIES_DIR = fixture.dir;
    _internal.clearCache();

    const res = await buildApp().request("/install/sk-windows-x64");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="sk_windows_x64.exe"',
    );
  });
});

describe("GET /install/{asset} — 404 paths (pointer body, install-script fallback contract)", () => {
  test("malformed asset slug → 404 with pointer body", async () => {
    const fixture = await mkBundle({ sk_linux_x64: new Uint8Array([1, 2, 3]) });
    activeDir = fixture.dir;
    process.env.SUBKIT_BINARIES_DIR = fixture.dir;
    _internal.clearCache();

    const res = await buildApp().request("/install/sk_linux_x64"); // underscore, not hyphen
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("github.com/MikeBild/subkit/releases");
  });

  test("unbuilt platform combo (windows-arm64) → 404", async () => {
    const fixture = await mkBundle({ sk_linux_x64: new Uint8Array([1, 2, 3]) });
    activeDir = fixture.dir;
    process.env.SUBKIT_BINARIES_DIR = fixture.dir;
    _internal.clearCache();

    const res = await buildApp().request("/install/sk-windows-arm64");
    expect(res.status).toBe(404);
  });

  test("bundle absent (slim image) → 404 for every asset URL", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "subkit-empty-bundle-"));
    activeDir = dir;
    process.env.SUBKIT_BINARIES_DIR = dir;
    _internal.clearCache();

    const app = buildApp();
    for (const url of ["/install/sk-linux-x64", "/install/agent-darwin-arm64"]) {
      const res = await app.request(url);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("engine-with-cli");
    }
  });

  test("bundle has SHA256SUMS but is missing the requested binary → 404", async () => {
    // Manifest lists sk_linux_x64; we ask for sk_darwin_arm64 which is
    // referenced in the manifest but the file is also absent.
    const dir = await fs.mkdtemp(path.join(tmpdir(), "subkit-partial-bundle-"));
    activeDir = dir;
    const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
    await fs.writeFile(path.join(dir, "sk_linux_x64"), bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    await fs.writeFile(path.join(dir, "SHA256SUMS"), `${sha}  sk_linux_x64\n`);
    process.env.SUBKIT_BINARIES_DIR = dir;
    _internal.clearCache();

    const res = await buildApp().request("/install/sk-darwin-arm64");
    expect(res.status).toBe(404);
  });
});

describe("GET /install/sha256sums", () => {
  test("returns the bundled SHA256SUMS verbatim with text/plain content-type", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fixture = await mkBundle({ sk_linux_x64: bytes, "tunnel-agent_linux_x64": bytes });
    activeDir = fixture.dir;
    process.env.SUBKIT_BINARIES_DIR = fixture.dir;
    _internal.clearCache();

    const res = await buildApp().request("/install/sha256sums");
    expect(res.status).toBe(200);
    // Hono's c.text() emits charset=UTF-8 (uppercase); the install
    // script and curl don't care, but pin the actual shape.
    expect(res.headers.get("content-type")).toMatch(/^text\/plain; charset=utf-?8$/i);
    const body = await res.text();
    expect(body).toContain("sk_linux_x64");
    expect(body).toContain("tunnel-agent_linux_x64");
    // Hash entries match what we wrote.
    const expectedSha = createHash("sha256").update(bytes).digest("hex");
    expect(body).toContain(expectedSha);
  });

  test("returns 404 with pointer body when the bundle is absent", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "subkit-empty-sums-"));
    activeDir = dir;
    process.env.SUBKIT_BINARIES_DIR = dir;
    _internal.clearCache();

    const res = await buildApp().request("/install/sha256sums");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("github.com/MikeBild/subkit/releases");
  });
});

describe("manifest cache", () => {
  test("re-uses parsed SHA256SUMS across requests for the same dir", async () => {
    const fixture = await mkBundle({ sk_linux_x64: new Uint8Array([1, 2, 3]) });
    activeDir = fixture.dir;
    process.env.SUBKIT_BINARIES_DIR = fixture.dir;
    _internal.clearCache();

    const first = await _internal.loadManifest(fixture.dir);
    const second = await _internal.loadManifest(fixture.dir);
    expect(first).toBe(second); // same object reference — cache hit
  });

  test("clearCache forces a fresh parse", async () => {
    const fixture = await mkBundle({ sk_linux_x64: new Uint8Array([1, 2, 3]) });
    activeDir = fixture.dir;
    process.env.SUBKIT_BINARIES_DIR = fixture.dir;
    _internal.clearCache();

    const first = await _internal.loadManifest(fixture.dir);
    _internal.clearCache();
    const second = await _internal.loadManifest(fixture.dir);
    expect(first).not.toBe(second);
  });
});
