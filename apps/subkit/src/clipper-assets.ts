import { z } from "zod";

const ManifestSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.array(z.string().min(1)).min(1),
});

export interface ClipperAssets {
  archivePath: string;
  manifest: z.infer<typeof ManifestSchema>;
}

async function importClipperAssets() {
  try {
    return await Promise.all([
      import("../../../assets/clipper/clipper.zip", { with: { type: "file" } }),
      import("../../../assets/clipper/manifest.json", { with: { type: "json" } }),
    ]);
  } catch {
    throw new Error("clipper archive is not built; run bun run build clipper");
  }
}

export async function loadClipperAssets(): Promise<ClipperAssets> {
  const [{ default: archivePath }, { default: manifestJson }] = await importClipperAssets();
  return { archivePath, manifest: ManifestSchema.parse(manifestJson) };
}
