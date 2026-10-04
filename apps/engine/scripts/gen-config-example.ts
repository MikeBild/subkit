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
