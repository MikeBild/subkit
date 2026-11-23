import { createHash } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../openapi.ts";

const ClipperManifestSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.array(z.string().min(1)).min(1),
});

interface VerifiedArchive {
  path: string;
  sha256: string;
  size: number;
}

let archiveVerification: Promise<VerifiedArchive> | null = null;

async function verifyArchive(): Promise<VerifiedArchive> {
  const [{ default: path }, { default: manifestJson }] = await Promise.all([
    import("../../../../../assets/clipper/clipper.zip", { with: { type: "file" } }),
    import("../../../../../assets/clipper/manifest.json", { with: { type: "json" } }),
  ]);
  const manifest = ClipperManifestSchema.parse(manifestJson);
  const buffer = await Bun.file(path).arrayBuffer();
  const sha256 = createHash("sha256").update(new Uint8Array(buffer)).digest("hex");
  if (sha256 !== manifest.sha256) {
    throw new Error("clipper archive checksum verification failed");
  }
  return { path, sha256, size: buffer.byteLength };
}

function getArchiveVerification(): Promise<VerifiedArchive> {
  archiveVerification ??= verifyArchive().catch((error: unknown) => {
    archiveVerification = null;
    throw error;
  });
  return archiveVerification;
}

const route = createRoute({
  method: "get",
  path: "/install/clipper.zip",
  tags: ["install"],
  summary: "Bundled Chrome clipping extension",
  description:
    "Downloads the Chrome clipping extension archive embedded in this engine binary. The x-subkit-sha256 response header verifies the archive bytes.",
  responses: {
    200: {
      description: "Extension archive",
      content: {
        "application/zip": {
          schema: z.string().openapi({ format: "binary" }),
        },
      },
    },
    503: {
      description: "Extension archive unavailable",
      content: { "text/plain": { schema: z.string() } },
    },
  },
});

export function registerInstallClipperRoute(app: OpenAPIHono<AppEnv>): void {
  app.openapi(route, async (c) => {
    try {
      const { path, sha256, size } = await getArchiveVerification();
      return c.body(Bun.file(path).stream(), 200, {
        "cache-control": "public, max-age=3600",
        "content-disposition": 'attachment; filename="clipper.zip"',
        "content-length": String(size),
        "content-type": "application/zip",
        "x-subkit-sha256": sha256,
      });
    } catch {
      return c.text("clipper archive unavailable\n", 503, { "cache-control": "no-store" });
    }
  });
}

export const _internal = {
  clearArchiveVerification: () => {
    archiveVerification = null;
  },
  verifyArchive,
};
