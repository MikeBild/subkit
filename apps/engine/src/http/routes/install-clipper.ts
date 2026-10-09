import { createHash } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import clipperArchivePath from "../../../../../assets/clipper/clipper.zip" with { type: "file" };
import clipperManifestJson from "../../../../../assets/clipper/manifest.json" with { type: "json" };
import type { AppEnv } from "../openapi.ts";

const ClipperManifestSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.array(z.string().min(1)).min(1),
});

const clipperManifest = ClipperManifestSchema.parse(clipperManifestJson);
let archiveVerification: Promise<{ size: number }> | null = null;

async function verifyArchive(): Promise<{ size: number }> {
  const archive = Bun.file(clipperArchivePath);
  const buffer = await archive.arrayBuffer();
  const sha256 = createHash("sha256").update(new Uint8Array(buffer)).digest("hex");
  if (sha256 !== clipperManifest.sha256) {
    throw new Error("clipper archive checksum verification failed");
  }
  return { size: buffer.byteLength };
}

function getArchiveVerification(): Promise<{ size: number }> {
  archiveVerification ??= verifyArchive();
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
      const { size } = await getArchiveVerification();
      return c.body(Bun.file(clipperArchivePath).stream(), 200, {
        "cache-control": "public, max-age=3600",
        "content-disposition": 'attachment; filename="clipper.zip"',
        "content-length": String(size),
        "content-type": "application/zip",
        "x-subkit-sha256": clipperManifest.sha256,
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
  clipperManifest,
  verifyArchive,
};
