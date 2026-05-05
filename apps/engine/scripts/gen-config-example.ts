// Generate subkit.config.example.json from ConfigSchema defaults.
//
// Output is byte-stable and feeds the `check:config-example-drift`
// quality gate. The example carries:
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

function main(): void {
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
  process.stdout.write(`${JSON.stringify(parsed.data, null, 2)}\n`);
}

main();
