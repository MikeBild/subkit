import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const KONVENTION = join(root, "COCKPIT-KONVENTION.md");

const konventionBytes = readFileSync(KONVENTION);
const konvention = konventionBytes.toString("utf8");

describe("the root copy of the family convention", () => {
  test("it is byte-identical to the reviewed v2.3 document", () => {
    const digest = createHash("sha256").update(konventionBytes).digest("hex");
    expect(digest, "COCKPIT-KONVENTION.md is no longer the reviewed v2.3 text").toBe(
      "21b45923319d53c0f7cf593ea1c6a4e0b3cec233fa257d5479044976114727e7",
    );
  });

  test("it carries the paragraphs v1.5 through v2.3 were cut for, not just its header", () => {
    expect(konvention).toContain("Version 2.3 · 03.10.2026");
    expect(konvention).toContain('**Leitregel (v2.1): Aufgaben leben nur auf der „Übersicht".**');
    expect(konvention).toContain("**Betriebsleiste.** Genau vier Werte in einem Raster");
    expect(konvention).toContain("Änderungen v2.3:");
    expect(konvention).toContain("### 0.1 Ein Fakt, ein Ort");
    expect(konvention).toContain("## 0. Wofür das Cockpit da ist");
    expect(konvention).toContain("**Wortmarke und App-Icon.**");
    expect(konvention).toContain("**8.4 Prüf-Seitenblatt.**");
    expect(konvention).toContain("**10.1 Zahlen führen auf Listen, die dasselbe zählen.**");
    expect(konvention).toContain("**8.5b Die Zahl selbst ist eine Design-Frage.**");
    expect(konvention).toContain("## 12. Berichts-Grammatik");
    expect(konvention).toContain("## 15. Audit-Trail");
    expect(konvention).toContain("Zeitpunkt · Vorgang · Art · Ergebnis · Verursacher");
  });

  test("§8 exists exactly once in it", () => {
    expect([...konvention.matchAll(/^#{2,4} 8\. /gm)]).toHaveLength(1);
  });
});
