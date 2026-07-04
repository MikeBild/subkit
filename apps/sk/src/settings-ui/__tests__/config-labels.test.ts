// Coverage lock for the Config-tab label table.
//
// The engine's Zod schema declares N config leaves. Every one of them
// must have a curated label in `lib/config-labels.ts` so the row body
// reads as plain English, not as a dotted machine path. If you add a
// new leaf to the engine schema and forget to add the label here,
// this test fails — your row would otherwise fall back to the
// derived "title-cased last segment" which is usually not what you
// want for a primary UI label.

import { describe, expect, test } from "bun:test";
import { listConfigLeaves } from "../../../../engine/src/config/walk.ts";
import {
  formatLabel,
  LABEL_BY_PATH,
  labelForPath,
  SECTION_LABEL,
  sectionLabel,
} from "../lib/config-labels.ts";

describe("config-labels — coverage lock", () => {
  test("every leaf in the engine schema has a curated label", () => {
    const leaves = listConfigLeaves();
    const missing: string[] = [];
    for (const leaf of leaves) {
      const path = leaf.path.join(".");
      // `tenants.*` is a record-valued overlay map keyed by tenant id —
      // it intentionally has no per-row UI representation and is
      // skipped by the Config tab. Don't require a label.
      if (path.startsWith("tenants.")) continue;
      if (!(path in LABEL_BY_PATH)) missing.push(path);
    }
    expect(missing).toEqual([]);
  });

  test("every section visible in the Config tab has a curated header", () => {
    const leaves = listConfigLeaves();
    const sections = new Set<string>();
    for (const leaf of leaves) {
      const top = leaf.path[0] ?? "";
      if (!top || top === "tenants") continue;
      sections.add(top);
    }
    const missing = [...sections].filter((s) => !(s in SECTION_LABEL));
    expect(missing).toEqual([]);
  });
});

describe("config-labels — pure helpers", () => {
  test("labelForPath returns the curated entry when available", () => {
    expect(labelForPath("llm.provider")).toBe("Primary AI provider");
    expect(labelForPath("ui.theme")).toBe("Theme");
    expect(labelForPath("repl.portalTokenTtlMin")).toBe("Portal token TTL (minutes)");
  });

  test("labelForPath falls back to formatLabel for unknown paths", () => {
    expect(labelForPath("not.a.real.leaf")).toBe("Leaf");
    expect(labelForPath("legacy.some_flag")).toBe("Some flag");
  });

  test("formatLabel humanizes the last segment", () => {
    expect(formatLabel("storage.s3.access_key")).toBe("Access key");
    expect(formatLabel("repl.permissionMode")).toBe("PermissionMode");
    // Single segment with no dot.
    expect(formatLabel("solo_thing")).toBe("Solo thing");
  });

  test("sectionLabel returns curated headers", () => {
    expect(sectionLabel("llm")).toBe("AI / LLM");
    expect(sectionLabel("repl")).toBe("REPL session");
    expect(sectionLabel("ui")).toBe("REPL chrome");
  });

  test("sectionLabel falls back to capitalized identifier", () => {
    expect(sectionLabel("plugins")).toBe("Plugins");
  });
});
