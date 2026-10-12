const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: bun run demo:local:verify");
  console.log("Runs the local API journey followed by the functional browser journey.");
  process.exit(0);
}
if (args.length > 0) throw new Error(`Unknown option: ${args[0]}`);

for (const command of [
  ["scripts/verify-cockpit-local.ts", "--keep-workflow"],
  ["scripts/verify-local-cockpit-browser.mjs"],
]) {
  const result = Bun.spawnSync(["bun", ...command], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}
