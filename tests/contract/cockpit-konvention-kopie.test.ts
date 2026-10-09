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
  test("it is byte-identical to the reviewed v2.4 document", () => {
    const digest = createHash("sha256").update(konventionBytes).digest("hex");
    expect(digest, "COCKPIT-KONVENTION.md is no longer the reviewed v2.4 text").toBe(
      "9f948aef4c0fc6ead98971f9347f494082b3f43172df19674b3389f561a3241b",
    );
  });

  test("it carries the paragraphs v1.5 through v2.4 were cut for, not just its header", () => {
    expect(konvention).toContain("Version 2.4 · 09.10.2026");
    expect(konvention).toContain("Änderungen v2.4:");
    expect(konvention).toContain("## 16. Auftragskette");
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
    expect(konvention).toContain("Ereignis · Wer · Ergebnis · Wann");
  });

  test("§8 exists exactly once in it", () => {
    expect([...konvention.matchAll(/^#{2,4} 8\. /gm)]).toHaveLength(1);
  });
});
