export {};

if (process.argv.includes("--sandbox-worker")) {
  const { runSandboxWorker } = await import("./sandboxes/quickjs/worker.ts");
  try {
    await runSandboxWorker();
    process.exit(0);
  } catch {
    process.exit(1);
  }
} else {
  await import("./engine-main.ts");
}
