import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface RuntimeNoticeManifest {
  runtime: { version: string; revision: string };
  scope: string;
  correspondingSource?: string;
  files: Array<{
    component: string;
    revision: string;
    path: string;
    source: string;
    sha256: string;
  }>;
}

export async function renderRuntimeNotices(
  manifestPath: string,
  version: string,
  revision: string,
  runtime = "Bun",
): Promise<string> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as RuntimeNoticeManifest;
  if (manifest.runtime?.version !== version || manifest.runtime?.revision !== revision)
    throw new Error("Runtime notice manifest does not match the build toolchain");
  if (!manifest.scope?.trim() || !Array.isArray(manifest.files) || !manifest.files.length)
    throw new Error("Runtime notice inventory is empty");
  if (
    manifest.correspondingSource !== undefined &&
    !manifest.correspondingSource.includes(manifest.runtime.revision)
  )
    throw new Error("Corresponding source statement does not name the runtime revision");
  const parts = [
    "",
    "NATIVE RUNTIME NOTICE DRAFT — NOT A DISTRIBUTION APPROVAL",
    `${runtime} ${version} (${revision})`,
    manifest.scope,
  ];
  if (manifest.correspondingSource)
    parts.push("", "RELINKING AND CORRESPONDING SOURCE", manifest.correspondingSource);
  const seen = new Set<string>();
  for (const file of [...manifest.files].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
    if (
      !file.path ||
      /[/\\]/.test(file.path) ||
      !file.component?.trim() ||
      !file.revision?.trim() ||
      !file.source?.startsWith("https://") ||
      seen.has(file.path)
    )
      throw new Error("Invalid or duplicate runtime notice entry");
    seen.add(file.path);
    const bytes = await readFile(join(dirname(manifestPath), file.path));
    if (
      !bytes.toString("utf8").trim() ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    )
      throw new Error("Runtime notice checksum mismatch or empty text");
    parts.push(
      "",
      "=".repeat(72),
      `${file.component}@${file.revision}`,
      `Source: ${file.source}`,
      `File: ${file.path}`,
      `SHA-256: ${file.sha256}`,
      bytes.toString("utf8"),
    );
  }
  return `${parts.join("\n")}\n`;
}
