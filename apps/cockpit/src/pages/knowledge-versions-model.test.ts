import { describe, expect, test } from "bun:test";
import { actorDirectory } from "@/app/actor-directory-model";
import { CATALOGS, type TranslationKey, translate } from "@/lib/i18n";
import {
  authorName,
  type KnowledgeVersion,
  keptVersionCount,
  previousVersion,
  restoreHint,
  versionChange,
  versionText,
  versionWhy,
} from "./knowledge-versions-model";

const de = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);
const USER = "11111111-1111-4111-8111-111111111111";
const ROBOT = "22222222-2222-4222-8222-222222222222";
const directory = actorDirectory(
  { items: [{ id: USER, email: "lena@example.com" }] },
  { items: [{ id: USER, name: "Service" }] },
);

function version(over: Partial<KnowledgeVersion>): KnowledgeVersion {
  return {
    version: 1,
    content_hash: "h",
    author: null,
    note: null,
    created_at: "2026-10-01T10:00:00.000Z",
    current: false,
    ...over,
  };
}

describe("knowledge versions model", () => {
  test("a single document is its own text; several carry their path as a heading", () => {
    expect(versionText([{ path: "runbook.md", content: "# Runbook" }])).toBe("# Runbook");
    expect(
      versionText([
        { path: "/a.md", content: "A" },
        { path: "/b.md", content: "B" },
      ]),
    ).toBe("## /a.md\n\nA\n\n## /b.md\n\nB");
  });

  test("the change shows added and removed lines against the version before", () => {
    const rows = versionChange(
      [{ path: "r.md", content: "- phone at night" }],
      [{ path: "r.md", content: "- phone at night\n- lead after 15 minutes" }],
    );
    expect(rows).toEqual([
      { type: "context", text: "- phone at night" },
      { type: "added", text: "- lead after 15 minutes" },
    ]);
    expect(
      versionChange([{ path: "r.md", content: "x" }], [{ path: "r.md", content: "x" }]),
    ).toEqual([]);
  });

  test("an author is named from the directory, else by kind, and missing author remains undocumented", () => {
    expect(authorName({ kind: "user", id: USER }, directory, de)).toBe("lena@example.com");
    expect(authorName({ kind: "system_account", id: USER }, directory, de)).toBe("Service");
    expect(versionWhy(`proposed by system_account:${USER}`, directory, de)).toBe(
      "Vorschlag von Service",
    );
    expect(authorName({ kind: "user", id: ROBOT }, directory, de)).toBe("Person");
    expect(authorName({ kind: "system_account", id: ROBOT }, directory, de)).toBe("Systemkonto");
    expect(authorName(null, directory, de)).toBe("Unbekannt");
    expect(authorName(null, directory, (key) => translate("en", key))).toBe("Unknown");
  });

  test("the engine's notes read as a reason in the viewer's language", () => {
    expect(versionWhy("restored from v2", directory, de)).toBe("Wiederhergestellt aus v2");
    expect(versionWhy(`proposed by user:${USER}`, directory, de)).toBe(
      "Vorschlag von lena@example.com",
    );
    expect(versionWhy(`proposed by system_account:${ROBOT}`, directory, de)).toBe(
      "Vorschlag von Systemkonto",
    );
    expect(versionWhy("proposed by an agent", directory, de)).toBe(
      "Vorschlag aus einer Unterhaltung",
    );
    expect(versionWhy("hand edit", directory, de)).toBe("hand edit");
    expect(versionWhy(null, directory, de)).toBeNull();
  });

  test("the change is shown against the version before, while the history still keeps it", () => {
    const kept = [{ version: 4 }, { version: 3 }, { version: 2 }];
    expect(previousVersion(kept, 4)).toBe(3);
    expect(previousVersion(kept, 2)).toBeNull();
    expect(previousVersion([{ version: 1 }], 1)).toBeNull();
  });

  test("the hint says what restoring creates, or that this is what agents read", () => {
    expect(restoreHint(version({ version: 1 }), 3, de)).toBe(
      "Wiederherstellen legt v4 mit diesem Stand an; v3 bleibt im Verlauf.",
    );
    expect(restoreHint(version({ version: 3, current: true }), 3, de)).toBe(
      "Das ist die neueste Version; Agenten und Workflows lesen diesen Stand.",
    );
  });

  test("every versions string exists in both languages", () => {
    const keys = Object.keys(CATALOGS.en).filter((key) => key.startsWith("knowledge.versions."));
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) expect(CATALOGS.de[key as TranslationKey]).toBeTruthy();
  });
});

describe("version count", () => {
  test("the version in use always counts, so the summary never reads 0 next to 'only this version'", () => {
    expect(keptVersionCount(0)).toBe(1);
    expect(keptVersionCount(1)).toBe(1);
    expect(keptVersionCount(3)).toBe(3);
    expect(translate("de", "skills.versions.one", { count: keptVersionCount(0) })).toBe(
      "1 Version",
    );
    expect(translate("de", "knowledge.versions.empty")).toBe("Nur diese Version.");
  });
});
