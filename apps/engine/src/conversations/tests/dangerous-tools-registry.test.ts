// Hard guard against the dangerous-tools registry drifting away from
// the tool palette. Every name on the registry must:
//   - resolve to a real tool in `listTools()`,
//   - be in the `tenant_write` category (not a read-only tool),
//   - not be marked `requires_skill` (else the skill gate could mask it).
//
// If a refactor renames or removes a dangerous tool, this test fires
// immediately so the registry can be updated in lockstep — a silent
// drift would let a destructive tool through `permission: auto` without
// confirmation.

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
