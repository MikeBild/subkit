import { promises as fs } from "node:fs";
import path from "node:path";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { readEnv } from "../../env.ts";
import { logger } from "../../logging/index.ts";
import type { AppEnv } from "../openapi.ts";

const DEFAULT_BINARIES_DIR = "/usr/local/share/subkit/binaries";
const SUMS_FILENAME = "SHA256SUMS";
const SIGNATURE_FILENAME = "SHA256SUMS.sig";

const POINTER_BODY =
  "binary not bundled in this engine image — pull the engine-with-cli variant or fetch from https://github.com/MikeBild/subkit/releases\n";

interface BundleManifest {
  sums: Map<string, string>;
  sumsRaw: string;
}

const manifestCache = new Map<string, BundleManifest>();

function getBinariesDir(): string {
  const envDir = readEnv("SUBKIT_BINARIES_DIR");
  return envDir && envDir.length > 0 ? envDir : DEFAULT_BINARIES_DIR;
}

async function loadManifest(dir: string): Promise<BundleManifest | "absent"> {
  const cached = manifestCache.get(dir);
  if (cached !== undefined) return cached;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, SUMS_FILENAME), "utf8");
  } catch {
    return "absent";
  }
  const sums = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
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
  kind: "sk";
  platform: "darwin" | "linux" | "windows";
  arch: "arm64" | "x64";
}

function parseAsset(asset: string): ParsedAsset | null {
  const match = asset.match(/^(sk)-(darwin|linux|windows)-(arm64|x64)$/);
  if (!match) return null;
  const kind = match[1] as ParsedAsset["kind"];
  const platform = match[2] as ParsedAsset["platform"];
  const arch = match[3] as ParsedAsset["arch"];
  if (platform === "windows" && arch === "arm64") return null;
  return { kind, platform, arch };
}

function diskFilename(parsed: ParsedAsset): string {
  const ext = parsed.platform === "windows" ? ".exe" : "";
  return `sk_${parsed.platform}_${parsed.arch}${ext}`;
}

const AssetParam = z.object({
  asset: z
    .string()
    .min(1)
    .openapi({
      param: { name: "asset", in: "path" },
      example: "sk-darwin-arm64",
      description:
        "Asset slug or LICENSE / THIRD_PARTY_NOTICES.txt. Binary grammar: `sk-(darwin|linux|windows)-(arm64|x64)`. windows-arm64 is not built.",
    }),
});

const sumsRoute = createRoute({
  method: "get",
  path: "/install/sha256sums",
  tags: ["install"],
  summary: "Bundled SHA256SUMS for the binaries shipped in this image",
  description:
    "Returns the verbatim SHA256SUMS file for the `sk` binary bundled in this engine image. 404 when the slim image is in use; clients should fall back to https://github.com/MikeBild/subkit/releases for the matching tag.",
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

const signatureRoute = createRoute({
  method: "get",
  path: "/install/sha256sums.sig",
  tags: ["install"],
  summary: "Release signature of the bundled SHA256SUMS",
  description:
    "Returns the Ed25519 release signature over /install/sha256sums, so `sk update` verifies an engine-served binary exactly like a GitHub release asset. 404 when the bundle or its signature is absent.",
  responses: {
    200: {
      description: "Detached Ed25519 signature",
      content: {
        "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) },
      },
    },
    404: {
      description: "Signature unavailable",
      content: { "text/plain": { schema: z.string() } },
    },
  },
});

const assetRoute = createRoute({
  method: "get",
  path: "/install/{asset}",
  tags: ["install"],
  summary: "Bundled sk binary or license notice",
  description:
    "Streams the sk CLI binary or its LICENSE/THIRD_PARTY_NOTICES.txt bundled in the engine-with-cli image variant. Returns 404 with a pointer body when the bundle is absent, the asset name is malformed, or the requested platform/arch is not built. Verifies bytes via the `x-subkit-sha256` response header.",
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

  app.openapi(signatureRoute, async (c) => {
    const dir = getBinariesDir();
    let signature: Buffer;
    try {
      signature = await fs.readFile(path.join(dir, SIGNATURE_FILENAME));
    } catch {
      return c.text(POINTER_BODY, 404, POINTER_HEADERS);
    }
    return c.body(new Uint8Array(signature), 200, {
      "content-type": "application/octet-stream",
      "content-length": String(signature.length),
      "cache-control": "public, max-age=3600",
    });
  });

  app.openapi(assetRoute, async (c) => {
    const { asset } = c.req.valid("param");
    const parsed = parseAsset(asset);
    const notice = asset === "LICENSE" || asset === "THIRD_PARTY_NOTICES.txt";
    if (!parsed && !notice) {
      return c.text(POINTER_BODY, 404, POINTER_HEADERS);
    }
    const dir = getBinariesDir();
    const manifest = await loadManifest(dir);
    if (manifest === "absent") {
      return c.text(POINTER_BODY, 404, POINTER_HEADERS);
    }
    const filename = parsed ? diskFilename(parsed) : asset;
    const sha = manifest.sums.get(filename);
    if (!sha) {
      return c.text(POINTER_BODY, 404, POINTER_HEADERS);
    }
    const filePath = path.join(dir, filename);
    let stat: { size: number };
    try {
      stat = await fs.stat(filePath);
    } catch {
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

export const _internal = {
  clearCache: () => manifestCache.clear(),
  parseAsset,
  diskFilename,
  loadManifest,
};
