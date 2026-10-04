import { describe, expect, test } from "bun:test";
import { DANGEROUS_TOOLS } from "../dangerous-tools.ts";
import { listTools } from "../tools/index.ts";

describe("dangerous-tools registry", () => {
  const tools = listTools();
  const byName = new Map(tools.map((t) => [t.name, t] as const));

  for (const name of DANGEROUS_TOOLS) {
    test(`${name} exists in the conversation tool palette`, () => {
      const tool = byName.get(name);
      expect(tool).toBeDefined();
    });

    test(`${name} is a tenant_write tool`, () => {
      const tool = byName.get(name);
      expect(tool?.category).toBe("tenant_write");
    });
  }
});
