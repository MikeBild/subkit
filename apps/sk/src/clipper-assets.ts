import { z } from "zod";
import archivePath from "../../../assets/clipper/clipper.zip" with { type: "file" };
import manifestJson from "../../../assets/clipper/manifest.json" with { type: "json" };

const ManifestSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.array(z.string().min(1)).min(1),
});

export const clipperArchivePath = archivePath;
export const clipperArchiveManifest = ManifestSchema.parse(manifestJson);
