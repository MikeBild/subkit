import { describe, expect, test } from "bun:test";
import { actorDirectory } from "@/app/actor-directory-model";
import {
  sourceSizeText,
  sourceStripAction,
  sourceStripText,
  sourceVersionItems,
} from "@/features/knowledge/model/source-detail-model";
import { type TranslationKey, translate } from "@/lib/i18n";

const en = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);
const USER = "11111111-1111-4111-8111-111111111111";

describe("the source detail", () => {
  test("a failed source offers its remedy, an inactive one can be turned on by a writer", () => {
    expect(sourceStripAction("failed", "retry", true)).toBe("retry");
    expect(sourceStripAction("failed", "chat", false)).toBe("chat");
    expect(sourceStripAction("failed", null, true)).toBeNull();
    expect(sourceStripAction("off", "retry", true)).toBe("activate");
    expect(sourceStripAction("off", "chat", false)).toBeNull();
    expect(sourceStripAction("active", "retry", true)).toBeNull();
  });

  test("the strip names when it was read, why it failed, or else its status", () => {
    const rel = () => "2 h ago";
    const at = "2026-11-20T10:00:00Z";
    expect(sourceStripText({ status: "active", error: null, ingested: at }, en, rel)).toBe(
      en("kn.sources.stripActive", { when: "2 h ago" }),
    );
    expect(sourceStripText({ status: "failed", error: "timeout", ingested: at }, en, rel)).toBe(
      `${en("kn.sources.status.failed")} · timeout`,
    );
    expect(sourceStripText({ status: "failed", error: null, ingested: at }, en, rel)).toBe(
      en("kn.sources.status.failed"),
    );
    expect(sourceStripText({ status: "off", error: null, ingested: at }, en, rel)).toBe(
      en("kn.status.off"),
    );
  });

  test("the size names the sections and the bytes when they are known", () => {
    expect(sourceSizeText("5 sections", "1.2 kB")).toBe("5 sections · 1.2 kB");
    expect(sourceSizeText("5 sections", null)).toBe("5 sections");
  });

  test("versions carry their author and reason in words", () => {
    const directory = actorDirectory({ items: [{ id: USER, email: "lena@example.com" }] }, {});
    const items = sourceVersionItems(
      [
        {
          version: 2,
          author: { kind: "user", id: USER },
          created_at: "b",
          current: true,
          note: "restored from v1",
        },
        { version: 1, author: null, created_at: "a", current: false, note: null },
      ],
      directory,
      en,
    );
    expect(items).toEqual([
      {
        key: "2",
        v: 2,
        by: "lena@example.com",
        at: "b",
        current: true,
        note: en("knowledge.versions.restoredFrom", { version: 1 }),
      },
      { key: "1", v: 1, by: en("runs.caller.unknown"), at: "a", current: false, note: null },
    ]);
  });
});
