import { describe, expect, test } from "bun:test";

describe("MCP credential receipt audit boundary", () => {
  test("persists replay receipts through the canonical audit writer", async () => {
    const source = await Bun.file(new URL("./persist-credential.ts", import.meta.url)).text();
    expect(source).not.toMatch(/\.insert\s*\(\s*auditLog\s*\)/);
    expect(source).toMatch(/await writeAudit\(/);
  });
});
