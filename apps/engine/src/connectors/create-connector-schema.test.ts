import { describe, expect, test } from "bun:test";
import { CreateConnectorSchema } from "./types.ts";

const stdioBody = {
  name: "Gateway",
  slug: "gateway",
  driver: "mcp",
  environment: "prod",
  auth_type: "none",
  config: { mcp: { transport: "stdio", command: "docker", args: ["mcp", "gateway", "run"] } },
};

describe("CreateConnectorSchema stdio address contract", () => {
  test.each([
    ["absent", {}, true],
    ["null", { base_url: null }, false],
    ["set", { base_url: "https://example.com/mcp" }, false],
  ] as const)("base_url %s", (_label, address, accepted) => {
    expect(CreateConnectorSchema.safeParse({ ...stdioBody, ...address }).success).toBe(accepted);
  });
});
