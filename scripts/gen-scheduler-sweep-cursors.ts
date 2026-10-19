import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function renderSchedulerSweepSeedSql(values: readonly string[]): string {
  if (
    values.length !== 8 ||
    new Set(values).size !== 8 ||
    values.some((value) => !/^[a-z-]+$/.test(value))
  )
    throw new Error("scheduler_sweep_producers_invalid");
  return `INSERT INTO "scheduler_sweep_cursors" ("producer") VALUES ${values.map((value) => `('${value}')`).join(", ")};\n`;
}

if (import.meta.main) {
  const directory = join(import.meta.dir, "../apps/engine/src/db/migrations");
  const journal = JSON.parse(readFileSync(join(directory, "meta/_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const entry = journal.entries.find((value) => value.tag.endsWith("_scheduler_sweep_cursors"));
  if (!entry) throw new Error("scheduler_sweep_migration_missing");
  const snapshot = JSON.parse(
    readFileSync(
      join(directory, `meta/${String(entry.idx).padStart(4, "0")}_snapshot.json`),
      "utf8",
    ),
  ) as { enums: Record<string, { values: string[] }> };
  const values = snapshot.enums["public.scheduler_sweep_producer"]?.values;
  if (!values) throw new Error("scheduler_sweep_producers_missing");
  const filename = join(directory, `${entry.tag}.sql`);
  const original = readFileSync(filename, "utf8");
  const marker = '\n--> statement-breakpoint\nINSERT INTO "scheduler_sweep_cursors"';
  const body = original.split(marker)[0]?.trimEnd();
  if (!body) throw new Error("scheduler_sweep_ddl_missing");
  writeFileSync(
    filename,
    `${body}\n--> statement-breakpoint\n${renderSchedulerSweepSeedSql(values)}`,
  );
}
