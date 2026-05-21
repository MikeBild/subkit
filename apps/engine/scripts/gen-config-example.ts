// Generate subkit.config.example.json from ConfigSchema defaults.
//
// Output is byte-stable for a given ConfigSchema. The drift gate
// `check:config-example-drift` regenerates the file and exits
// non-zero if the working tree differs from the regenerated output —
// the gate runs against the operator's checked-out schema, so a
// schema change that lands without the example regen is caught at
// `bun run verify` time on the next CI run.
//
// The example carries:
//   - every leaf populated to its schema default
//   - database.url pre-filled with a USER:PASSWORD@host/db placeholder
//     so a copy-paste keeps the file valid JSON until the operator
//     edits it
//
// Wired into `bun run verify` via the drift gate; never invoke during
// runtime.
//
// Usage:
//   bun run apps/engine/scripts/gen-config-example.ts > subkit.config.example.json

import { ConfigSchema } from "../src/config/schema.ts";

async function main(): Promise<void> {
  const parsed = ConfigSchema.safeParse({
    database: { url: "postgresql://USER:PASSWORD@localhost:5432/subkit" },
  });
  if (!parsed.success) {
    process.stderr.write(
      `gen-config-example: schema parse of defaults failed:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n")}\n`,
    );
    process.exit(2);
  }
  // Format through biome so the generated file is byte-identical to what
  // `bun run lint` expects — `JSON.stringify` always multi-lines arrays
  // while biome keeps short ones inline, which would otherwise leave the
  // generated example perpetually lint-dirty.
  const raw = JSON.stringify(parsed.data, null, 2);
  const proc = Bun.spawn(
    ["bunx", "biome", "format", "--stdin-file-path=subkit.config.example.json"],
    { stdin: new TextEncoder().encode(raw), stdout: "pipe" },
  );
  const formatted = await new Response(proc.stdout).text();
  await proc.exited;
  process.stdout.write(formatted.endsWith("\n") ? formatted : `${formatted}\n`);
}

await main();
