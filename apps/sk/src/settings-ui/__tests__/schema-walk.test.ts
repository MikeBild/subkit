import { describe, expect, test } from "bun:test";
import { listConfigLeaves } from "../../../../engine/src/config/walk.ts";
import type { SettingLeafEntry } from "../../engine-client.ts";
import { leafToFormField } from "../lib/zod-to-form-fields.ts";

describe("zod-to-form-fields × live ConfigSchema", () => {
  test("every leaf in ConfigSchema maps to a non-null FormFieldKind", () => {
    const leaves = listConfigLeaves();
    expect(leaves.length).toBeGreaterThan(50);

    for (const leaf of leaves) {
      const wire: SettingLeafEntry = {
        path: leaf.path.join("."),
        value: undefined,
        meta: {
          source: "default",
          scope: leaf.meta.scope ?? "global",
          sensitive: !!leaf.meta.secret,
          requiresRestart: !!leaf.meta.requiresRestart,
          kind: leaf.kind,
          ...(leaf.description ? { description: leaf.description } : {}),
        },
      };
      const field = leafToFormField(wire);
      expect(
        field.kind,
        `leaf ${leaf.path.join(".")} (${leaf.kind}) should map to a known kind`,
      ).not.toBe(undefined);
      if (field.kind === "json") {
        expect(
          ["string-array", "json"],
          `unexpected json fallback for ${leaf.path.join(".")}`,
        ).toContain(leaf.kind);
      }
    }
  });

  test("every secret leaf renders as a `secret` field regardless of underlying kind", () => {
    const leaves = listConfigLeaves();
    for (const leaf of leaves) {
      if (!leaf.meta.secret) continue;
      const wire: SettingLeafEntry = {
        path: leaf.path.join("."),
        value: undefined,
        meta: {
          source: "default",
          scope: leaf.meta.scope ?? "global",
          sensitive: true,
          requiresRestart: !!leaf.meta.requiresRestart,
          kind: leaf.kind,
        },
      };
      expect(leafToFormField(wire).kind).toBe("secret");
    }
  });
});
