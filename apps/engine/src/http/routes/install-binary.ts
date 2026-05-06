// Bundled-binary download endpoint — opt-in, served from the
// `engine-with-cli` Docker image variant.
//
// An operator running on an air-gapped or proxy-restricted network cannot
// reach github.com to download the `sk` / `tunnel-agent` binaries. This
// route serves them directly from the engine itself, from
// `/usr/local/share/subkit/binaries/` (override via SUBKIT_BINARIES_DIR).
//
// The default slim engine image does NOT bundle binaries — every route
// here returns 404 with a pointer message. The `/install` shell script
// probes the bundled URL first and falls back to GitHub Releases, so a
// single install command works for both image variants.
//
// URL grammar:
//   GET /install/sha256sums            → text/plain SHA256SUMS file
//   GET /install/sk-<platform>-<arch>  → application/octet-stream sk binary
//   GET /install/agent-<platform>-<arch> → application/octet-stream tunnel-agent
//
// Allowed combos match the release matrix:
//   {sk,agent} × darwin × {arm64,x64}
//   {sk,agent} × linux  × {arm64,x64}
//   {sk,agent} × windows × x64        (.exe on disk, no .exe in URL)
//
// On disk the artifact names use underscores (`sk_darwin_arm64`,
// `tunnel-agent_linux_x64`, `sk_windows_x64.exe`) — matching what the
// release workflow uploads to GitHub. The handler maps URL hyphens to
// disk underscores and rewrites `agent` → `tunnel-agent`.
//
// Public, unauthenticated. Same trust posture as the existing /install
// shell-script endpoint and the Tailscale precedent it follows: the
// bytes are SHA256-verified by the install script against
// /install/sha256sums (or, when bundled, the headers expose
// `x-subkit-sha256` for clients that prefer header verification).

import { promises as fs } from "node:fs";
import path from "node:path";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { logger } from "../../logging/index.ts";
import type { AppEnv } from "../openapi.ts";

const DEFAULT_BINARIES_DIR = "/usr/local/share/subkit/binaries";
const SUMS_FILENAME = "SHA256SUMS";

const POINTER_BODY =
  "binary not bundled in this engine image — pull the engine-with-cli variant or fetch from https://github.com/MikeBild/subkit/releases\n";

interface BundleManifest {
  sums: Map<string, string>; // filename → sha256 hex
  sumsRaw: string; // verbatim SHA256SUMS content
}

// Per-directory cache. Tests use a fresh tmpdir per test run and call
// `_internal.clearCache()` between assertions so a stale parse does
// not leak across cases.
const manifestCache = new Map<string, BundleManifest | "absent">();

function getBinariesDir(): string {
  const envDir = process.env.SUBKIT_BINARIES_DIR;
  return envDir && envDir.length > 0 ? envDir : DEFAULT_BINARIES_DIR;
}

async function loadManifest(dir: string): Promise<BundleManifest | "absent"> {
  const cached = manifestCache.get(dir);
  if (cached !== undefined) return cached;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, SUMS_FILENAME), "utf8");
  } catch {
    manifestCache.set(dir, "absent");
    return "absent";
  }
  const sums = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Accept both `<hash>  <name>` (sha256sum -b) and `<hash> <name>`.
    const match = trimmed.match(/^([0-9a-f]{64})\s+\*?(\S+)$/i);
    if (!match) continue;
    const hash = match[1];
    const name = match[2];
    if (!hash || !name) continue;
    sums.set(name, hash.toLowerCase());
  }
  const manifest: BundleManifest = { sums, sumsRaw: raw };
  manifestCache.set(dir, manifest);
  return manifest;
}

interface ParsedAsset {
  kind: "sk" | "agent";
  platform: "darwin" | "linux" | "windows";
  arch: "arm64" | "x64";
}

function parseAsset(asset: string): ParsedAsset | null {
  const match = asset.match(/^(sk|agent)-(darwin|linux|windows)-(arm64|x64)$/);
  if (!match) return null;
  const kind = match[1] as ParsedAsset["kind"];
  const platform = match[2] as ParsedAsset["platform"];
  const arch = match[3] as ParsedAsset["arch"];
  // The release matrix does not produce windows-arm64.
  if (platform === "windows" && arch === "arm64") return null;
  return { kind, platform, arch };
}

function diskFilename(parsed: ParsedAsset): string {
  const prefix = parsed.kind === "sk" ? "sk" : "tunnel-agent";
  const ext = parsed.platform === "windows" ? ".exe" : "";
  return `${prefix}_${parsed.platform}_${parsed.arch}${ext}`;
}

const AssetParam = z.object({
  asset: z
    .string()
    .min(1)
    .openapi({
      param: { name: "asset", in: "path" },
      example: "sk-darwin-arm64",
      description:
        "Asset slug. Grammar: `(sk|agent)-(darwin|linux|windows)-(arm64|x64)`. windows-arm64 is not built.",
    }),
});

const sumsRoute = createRoute({
  method: "get",
  path: "/install/sha256sums",
  tags: ["install"],
  summary: "Bundled SHA256SUMS for the binaries shipped in this image",
  description:
    "Returns the verbatim SHA256SUMS file for the `sk` and `tunnel-agent` binaries bundled in this engine image. 404 when the slim image is in use; clients should fall back to https://github.com/MikeBild/subkit/releases for the matching tag.",
  responses: {
    200: {
      description: "SHA256SUMS text",
      content: { "text/plain": { schema: z.string() } },
    },
    404: {
      description: "Bundle absent (slim engine image)",
      content: { "text/plain": { schema: z.string() } },
    },
  },
});

const assetRoute = createRoute({
  method: "get",
  path: "/install/{asset}",
  tags: ["install"],
  summary: "Bundled sk / tunnel-agent binary",
  description:
    "Streams a CLI binary bundled in the engine-with-cli image variant. Returns 404 with a pointer body when the bundle is absent, the asset name is malformed, or the requested platform/arch is not built. Verifies bytes via the `x-subkit-sha256` response header.",
  request: { params: AssetParam },
  responses: {
    200: {
      description: "Binary stream",
      content: {
        "application/octet-stream": {
          schema: z.string().openapi({ format: "binary" }),
        },
      },
    },
    404: {
      description: "Asset unavailable",
      content: { "text/plain": { schema: z.string() } },
    },
  },
});

// 200 and 404 responses are both text/plain on /install/sha256sums and
// the 404 branch of /install/{asset}. @hono/zod-openapi requires
// `c.text()` (not `c.body()`) when the schema's content-type is
// text/plain — the typed return carries `_format: "text"` whereas
// `c.body()` returns `_format: "body"`. The 200 branch of
// /install/{asset} streams an application/octet-stream so it uses
// `c.body()` which accepts a ReadableStream.
const POINTER_HEADERS = {
  "cache-control": "no-store",
} as const;

export function registerInstallBinaryRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(sumsRoute, async (c) => {
    const dir = getBinariesDir();
    const manifest = await loadManifest(dir);
    if (manifest === "absent") {
      return c.text(POINTER_BODY, 404, POINTER_HEADERS);
    }
    return c.text(manifest.sumsRaw, 200, {
      "cache-control": "public, max-age=3600",
    });
  });

  app.openapi(assetRoute, async (c) => {
    const { asset } = c.req.valid("param");
    const parsed = parseAsset(asset);
    if (!parsed) {
      return c.text(POINTER_BODY, 404, POINTER_HEADERS);
    }
    const dir = getBinariesDir();
    const manifest = await loadManifest(dir);
    if (manifest === "absent") {
      return c.text(POINTER_BODY, 404, POINTER_HEADERS);
    }
    const filename = diskFilename(parsed);
    const sha = manifest.sums.get(filename);
    if (!sha) {
      // Listed in URL grammar but not present in the manifest — the
      // image bundles a partial set. Treat as 404 so the install
      // script's fallback path kicks in cleanly.
      return c.text(POINTER_BODY, 404, POINTER_HEADERS);
    }
    const filePath = path.join(dir, filename);
    let stat: { size: number };
    try {
      stat = await fs.stat(filePath);
    } catch {
      // SHA listed but file missing — image build dropped it. Log so
      // an operator notices, return 404 to stay consistent.
      logger.warn({
        module: "http.install_binary",
        action: "binary_missing",
        msg: "SHA256SUMS lists binary but file is absent",
        filename,
        dir,
      });
      return c.text(POINTER_BODY, 404, POINTER_HEADERS);
    }
    const file = Bun.file(filePath);
    return c.body(file.stream(), 200, {
      "content-type": "application/octet-stream",
      "content-length": String(stat.size),
      "content-disposition": `attachment; filename="${filename}"`,
      "x-subkit-sha256": sha,
      "cache-control": "public, max-age=3600",
    });
  });
}

// Exported for tests.
export const _internal = {
  clearCache: () => manifestCache.clear(),
  parseAsset,
  diskFilename,
  loadManifest,
};
