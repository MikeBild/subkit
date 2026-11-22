import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { testEnv } from "../../test-helpers/determinism/env.ts";
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
  originalEnvDir = testEnv.SUBKIT_BINARIES_DIR;
  _internal.clearCache();
});

afterEach(async () => {
  if (originalEnvDir === undefined) {
    delete testEnv.SUBKIT_BINARIES_DIR;
  } else {
    testEnv.SUBKIT_BINARIES_DIR = originalEnvDir;
  }
  if (activeDir) {
    await fs.rm(activeDir, { recursive: true, force: true });
    activeDir = null;
  }
  _internal.clearCache();
});

describe("isServedFile", () => {
  test("serves exactly the release file names of the CLI and its notices", () => {
    for (const asset of [
      "subkit-darwin-arm64",
      "subkit-linux-arm64",
      "subkit-linux-x64",
      "subkit-windows-x64.exe",
      "LICENSE",
      "THIRD_PARTY_NOTICES.txt",
    ]) {
      expect(_internal.isServedFile(asset)).toBe(true);
    }
  });

  test("refuses unbuilt targets, other binaries and malformed names", () => {
    for (const asset of [
      "subkit-darwin-x64",
      "subkit-windows-arm64.exe",
      "subkit-windows-x64",
      "engine_linux_x64",
      "SHA256SUMS.next",
      "",
      "..%2Fetc%2Fpasswd",
    ]) {
      expect(_internal.isServedFile(asset)).toBe(false);
    }
  });
});

describe("GET /install/{asset} — bundled image", () => {
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.txt"]) {
    test(`serves only manifest-listed ${name}`, async () => {
      const bytes = new TextEncoder().encode("license fixture");
      const fixture = await mkBundle({ [name]: bytes });
      activeDir = fixture.dir;
      testEnv.SUBKIT_BINARIES_DIR = fixture.dir;
      const response = await buildApp().request(`/install/${name}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("license fixture");
      expect(response.headers.get("x-subkit-sha256")).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      await fs.writeFile(path.join(fixture.dir, "SHA256SUMS"), "");
      _internal.clearCache();
      expect((await buildApp().request(`/install/${name}`)).status).toBe(404);
    });
  }

  test("streams the subkit binary with sha header + correct length", async () => {
    const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]);
    const fixture = await mkBundle({ "subkit-linux-x64": bytes });
    activeDir = fixture.dir;
    testEnv.SUBKIT_BINARIES_DIR = fixture.dir;
    _internal.clearCache();

    const res = await buildApp().request("/install/subkit-linux-x64");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="subkit-linux-x64"');
    const expectedSha = createHash("sha256").update(bytes).digest("hex");
    expect(res.headers.get("x-subkit-sha256")).toBe(expectedSha);

    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBe(bytes.byteLength);
    const actualSha = createHash("sha256").update(body).digest("hex");
    expect(actualSha).toBe(expectedSha);
  });

  test("HEAD request returns the same headers as GET (install-script probe contract)", async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const fixture = await mkBundle({ "subkit-linux-x64": bytes });
    activeDir = fixture.dir;
    testEnv.SUBKIT_BINARIES_DIR = fixture.dir;
    _internal.clearCache();

    const res = await buildApp().request("/install/subkit-linux-x64", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-subkit-sha256")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(res.headers.get("content-length")).toBe(String(bytes.byteLength));
  });

  test("appends .exe on disk for windows targets but not in the URL", async () => {
    const bytes = new TextEncoder().encode("MZ-header-stub");
    const fixture = await mkBundle({ "subkit-windows-x64.exe": bytes });
    activeDir = fixture.dir;
    testEnv.SUBKIT_BINARIES_DIR = fixture.dir;
    _internal.clearCache();

    const res = await buildApp().request("/install/subkit-windows-x64.exe");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="subkit-windows-x64.exe"',
    );
  });
});

describe("GET /install/{asset} — 404 paths (pointer body, install-script fallback contract)", () => {
  test("malformed asset slug → 404 with pointer body", async () => {
    const fixture = await mkBundle({ "subkit-linux-x64": new Uint8Array([1, 2, 3]) });
    activeDir = fixture.dir;
    testEnv.SUBKIT_BINARIES_DIR = fixture.dir;
    _internal.clearCache();

    const res = await buildApp().request("/install/subkit_linux_x64");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("github.com/MikeBild/subkit/releases");
  });

  test("unbuilt platform combo (windows-arm64) → 404", async () => {
    const fixture = await mkBundle({ "subkit-linux-x64": new Uint8Array([1, 2, 3]) });
    activeDir = fixture.dir;
    testEnv.SUBKIT_BINARIES_DIR = fixture.dir;
    _internal.clearCache();

    const res = await buildApp().request("/install/subkit-windows-arm64.exe");
    expect(res.status).toBe(404);
  });

  test("bundle absent (slim image) → 404 for every asset URL", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "subkit-empty-bundle-"));
    activeDir = dir;
    testEnv.SUBKIT_BINARIES_DIR = dir;
    _internal.clearCache();

    const app = buildApp();
    const res = await app.request("/install/subkit-linux-x64");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("application-complete image");
  });

  test("bundle has SHA256SUMS but is missing the requested binary → 404", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "subkit-partial-bundle-"));
    activeDir = dir;
    const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
    await fs.writeFile(path.join(dir, "subkit-linux-x64"), bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    await fs.writeFile(path.join(dir, "SHA256SUMS"), `${sha}  subkit-linux-x64\n`);
    testEnv.SUBKIT_BINARIES_DIR = dir;
    _internal.clearCache();

    const res = await buildApp().request("/install/subkit-darwin-arm64");
    expect(res.status).toBe(404);
  });
});

describe("GET /install/SHA256SUMS", () => {
  test("returns the bundled SHA256SUMS verbatim with text/plain content-type", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fixture = await mkBundle({ "subkit-linux-x64": bytes });
    activeDir = fixture.dir;
    testEnv.SUBKIT_BINARIES_DIR = fixture.dir;
    _internal.clearCache();

    const res = await buildApp().request("/install/SHA256SUMS");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain; charset=utf-?8$/i);
    const body = await res.text();
    expect(body).toContain("subkit-linux-x64");
    const expectedSha = createHash("sha256").update(bytes).digest("hex");
    expect(body).toContain(expectedSha);
  });

  test("returns 404 with pointer body when the bundle is absent", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "subkit-empty-sums-"));
    activeDir = dir;
    testEnv.SUBKIT_BINARIES_DIR = dir;
    _internal.clearCache();

    const res = await buildApp().request("/install/SHA256SUMS");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("github.com/MikeBild/subkit/releases");
  });
});

describe("manifest cache", () => {
  test("re-uses parsed SHA256SUMS across requests for the same dir", async () => {
    const fixture = await mkBundle({ "subkit-linux-x64": new Uint8Array([1, 2, 3]) });
    activeDir = fixture.dir;
    testEnv.SUBKIT_BINARIES_DIR = fixture.dir;
    _internal.clearCache();

    const first = await _internal.loadManifest(fixture.dir);
    const second = await _internal.loadManifest(fixture.dir);
    expect(first).toBe(second);
  });

  test("clearCache forces a fresh parse", async () => {
    const fixture = await mkBundle({ "subkit-linux-x64": new Uint8Array([1, 2, 3]) });
    activeDir = fixture.dir;
    testEnv.SUBKIT_BINARIES_DIR = fixture.dir;
    _internal.clearCache();

    const first = await _internal.loadManifest(fixture.dir);
    _internal.clearCache();
    const second = await _internal.loadManifest(fixture.dir);
    expect(first).not.toBe(second);
  });

  test("absence is NOT cached — a bundle staged after a miss is served without restart", async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), "subkit-late-stage-"));
    activeDir = dir;
    testEnv.SUBKIT_BINARIES_DIR = dir;
    _internal.clearCache();
    const app = buildApp();

    const miss = await app.request("/install/subkit-linux-x64");
    expect(miss.status).toBe(404);

    const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
    await fs.writeFile(path.join(dir, "subkit-linux-x64"), bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    await fs.writeFile(path.join(dir, "SHA256SUMS"), `${sha}  subkit-linux-x64\n`);

    const hit = await app.request("/install/subkit-linux-x64");
    expect(hit.status).toBe(200);
    expect(hit.headers.get("x-subkit-sha256")).toBe(sha);
  });
});

describe("GET /install/SHA256SUMS.sig", () => {
  test("serves the release signature beside the bundled sums, and 404 without it", async () => {
    const bundle = await mkBundle({ "subkit-darwin-arm64": new Uint8Array([1, 2, 3]) });
    activeDir = bundle.dir;
    testEnv.SUBKIT_BINARIES_DIR = bundle.dir;
    const missing = await buildApp().request("/install/SHA256SUMS.sig");
    expect(missing.status).toBe(404);
    const signature = new Uint8Array(64).fill(7);
    await fs.writeFile(path.join(bundle.dir, "SHA256SUMS.sig"), signature);
    const served = await buildApp().request("/install/SHA256SUMS.sig");
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(signature);
  });
});
