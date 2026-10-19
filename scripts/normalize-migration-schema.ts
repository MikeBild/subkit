import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function normalizeMigrationSchema(sql: string): string {
  return sql
    .replace(/REFERENCES "public"\./g, 'REFERENCES "subkit".')
    .replace(/ALTER TYPE "public"\./g, 'ALTER TYPE "subkit".');
}

export async function normalizeNewMigrations(): Promise<void> {
  const root = path.resolve(import.meta.dir, "..");
  const relativeDirectory = "apps/engine/src/db/migrations";
  const directory = path.join(root, relativeDirectory);
  const journal = JSON.parse(
    await readFile(path.join(directory, "meta/_journal.json"), "utf8"),
  ) as {
    entries: Array<{ tag: string }>;
  };
  const boundary = journal.entries.findIndex((entry) => entry.tag === "0041_isolated_schema");
  if (boundary < 0) throw new Error("Product schema isolation migration is missing");
  const generated = new Set(
    execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", relativeDirectory], {
      cwd: root,
      encoding: "utf8",
    })
      .trim()
      .split("\n"),
  );
  const metadata = [...generated]
    .filter(
      (filename) => filename.startsWith(`${relativeDirectory}/meta/`) && filename.endsWith(".json"),
    )
    .map((filename) => path.join(root, filename));
  metadata.push(path.join(directory, "meta/_journal.json"));
  execFileSync(process.execPath, ["x", "biome", "format", "--write", ...metadata], {
    cwd: root,
    stdio: "pipe",
  });
  for (const entry of journal.entries.slice(boundary + 1)) {
    const relative = `${relativeDirectory}/${entry.tag}.sql`;
    if (!generated.has(relative)) continue;
    const filename = path.join(root, relative);
    const original = await readFile(filename, "utf8");
    const normalized = normalizeMigrationSchema(original);
    if (normalized !== original) await writeFile(filename, normalized);
  }
}

if (import.meta.main) await normalizeNewMigrations();
