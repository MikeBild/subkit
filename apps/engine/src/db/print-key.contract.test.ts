import { expect, test } from "bun:test";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function run(scenario: "success" | "missing-tenant") {
  const script = `
import { mock } from "bun:test";
const root = ${JSON.stringify(ROOT)};
let selects = 0;
mock.module(root + "/db/client.ts", () => ({
  closeDb: async () => console.error("DB_CLOSED"),
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => {
      selects += 1;
      if (${JSON.stringify(scenario)} === "missing-tenant") return [];
      return selects === 1
        ? [{ id: "tenant-fixture", slug: "default" }]
        : [{ id: "account-fixture", tenant_id: "tenant-fixture" }];
    } }) }) }),
  }),
}));
mock.module(root + "/identity/service.ts", () => ({
  issueApiKey: async (input) => {
    if (input.tenant_id !== "tenant-fixture" || input.owner_id !== "account-fixture")
      throw new Error("wrong issuance owner");
    return { plaintext: "fixture-key-only" };
  },
}));
mock.module(root + "/logging/context.ts", () => ({
  newTraceId: () => "trace-fixture",
  withContext: async (_context, callback) => await callback(),
}));
mock.module(root + "/logging/logger.ts", () => ({
  logger: { fatal: (entry) => console.error("FATAL_ACTION=" + entry.action + ";" + entry.error) },
}));
await import(root + "/db/print-key.ts");
`;
  return Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
}

test("issues a key only for the default tenant's system account and closes the database", () => {
  const child = run("success");
  const stdout = new TextDecoder().decode(child.stdout);
  const stderr = new TextDecoder().decode(child.stderr);
  expect(child.exitCode, stderr).toBe(0);
  expect(stdout).toBe("fixture-key-only\n");
  expect(stderr).toContain("DB_CLOSED");
  expect(stderr).not.toContain("fixture-key-only");
});

test("fails closed without writing a key when the default tenant does not exist", () => {
  const child = run("missing-tenant");
  const stdout = new TextDecoder().decode(child.stdout);
  const stderr = new TextDecoder().decode(child.stderr);
  expect(child.exitCode).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("FATAL_ACTION=print_key.crashed");
  expect(stderr).toContain("no 'default' tenant");
  expect(stderr).toContain("DB_CLOSED");
  expect(stderr).not.toContain("fixture-key-only");
});
