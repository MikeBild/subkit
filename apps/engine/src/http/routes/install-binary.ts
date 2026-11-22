import { promises as fs } from "node:fs";
import path from "node:path";
import { CLI_ASSETS, RELEASE_NOTICES } from "@cli-core/release/assets.ts";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { readEnv } from "../../env.ts";
import { logger } from "../../logging/index.ts";
import type { AppEnv } from "../openapi.ts";

const DEFAULT_BINARIES_DIR = "/usr/local/share/subkit/binaries";
const SUMS_FILENAME = "SHA256SUMS";
const SIGNATURE_FILENAME = "SHA256SUMS.sig";

const POINTER_BODY =
  "subkit CLI not bundled in this engine image — use the application-complete image or https://github.com/MikeBild/subkit/releases/latest\n";

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

const SERVED_FILES: ReadonlySet<string> = new Set([...CLI_ASSETS, ...RELEASE_NOTICES]);

function isServedFile(asset: string): boolean {
  return SERVED_FILES.has(asset);
}

export async function binariesBundled(): Promise<boolean> {
  return (await loadManifest(getBinariesDir())) !== "absent";
}

const AssetParam = z.object({
  asset: z
    .string()
    .min(1)
    .openapi({
      param: { name: "asset", in: "path" },
      example: "subkit-darwin-arm64",
      description: `Release file name, as on the GitHub release: ${[...CLI_ASSETS, ...RELEASE_NOTICES].join(", ")}.`,
    }),
});

const sumsRoute = createRoute({
  method: "get",
  path: "/install/SHA256SUMS",
  tags: ["install"],
  summary: "Bundled SHA256SUMS for the CLI binaries shipped in this image",
  description:
    "Returns the verbatim SHA256SUMS file for the `subkit` CLI binaries bundled in this engine image, so /install works like a release download directory. 404 when the slim image is in use; clients then use the GitHub release of the same version.",
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
  path: "/install/SHA256SUMS.sig",
  tags: ["install"],
  summary: "Release signature of the bundled SHA256SUMS",
  description:
    "Returns the Ed25519 release signature over /install/SHA256SUMS, so `subkit update --match-engine` verifies an engine-served binary exactly like a GitHub release asset. 404 when the bundle or its signature is absent.",
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
  summary: "Bundled subkit CLI binary or license notice",
  description:
    "Streams a `subkit` CLI binary or its LICENSE/THIRD_PARTY_NOTICES.txt bundled in the application-complete image, under the same file names as the GitHub release. Returns 404 with a pointer body when the bundle is absent or the file is not part of it. Verifies bytes via the `x-subkit-sha256` response header.",
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
    if (!isServedFile(asset)) {
      return c.text(POINTER_BODY, 404, POINTER_HEADERS);
    }
    const dir = getBinariesDir();
    const manifest = await loadManifest(dir);
    if (manifest === "absent") {
      return c.text(POINTER_BODY, 404, POINTER_HEADERS);
    }
    const filename = asset;
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
  isServedFile,
  loadManifest,
};
