// Schema-walking integration test for the zod-to-form-fields bridge.
//
// The synthetic-input bridge test (zod-to-form-fields.test.ts) only
// exercises hand-crafted SettingLeafEntry objects; if a new Zod kind
// were added to ConfigSchema and the bridge missed it, that test would
// not catch the drift until production.
//
// This test walks the LIVE ConfigSchema via apps/engine/src/config/walk.ts,
// converts every leaf into the wire shape the engine emits over GET
// /v1/settings, and asserts every kind maps to a known FormFieldKind.
// A failure here means a new Zod type landed in the schema without a
// corresponding case in `mapKind`.

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
      // `json` is the explicit fallback for compound types we haven't
      // wired a dedicated component for. It's allowed but flagged so
      // an operator review can decide whether the leaf deserves a
      // dedicated input.
      if (field.kind === "json") {
        expect(["string-array"], `unexpected json fallback for ${leaf.path.join(".")}`).toContain(
          leaf.kind,
        );
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
