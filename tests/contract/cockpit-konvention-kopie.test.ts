// THE CONVENTION COPIES ARE COPIES, SO SOMETHING HAS TO HOLD THEM.
//
// §7 makes the family convention shared by being COPIED into six repositories,
// and §13 says a standard has one source and no diverging copies. This tree
// holds two copies: `COCKPIT-KONVENTION.md` at the root — the family document
// itself — and the verbatim German copy of §8 inside `apps/cockpit/UI-UX.md`,
// which is there because this product's attention list (on the Übersicht) is measured against it.
//
// Neither was held. Measured on 21.08.2026: `apps/cockpit/UI-UX.md` is named
// nowhere in scripts/, tests/, package.json, .github/ or apps/cockpit/src, and
// a paragraph "8.99 Erfundene Regel" pasted into it left `konvention:check` at
// exit 0. The root copy was bound only through its FIRST 400 CHARACTERS — the
// version header that `checkKonventionVersion()` reads, via `.slice(0, 400)` on
// an already-decoded string — so its body was held by nothing at all.
//
// CHARACTERS, NOT BYTES, and the two are not the same number in this document.
// `String.prototype.length` and `.slice()` count UTF-16 code units; this file is
// German, so „§", „·", the umlauts and the em dashes each cost more than one
// byte in UTF-8. The §8 slice below is 5961 code units and 6075 UTF-8 bytes —
// the same text, two units, a 114 gap. The one place in this file that really
// does work in bytes is the sha256 digest, which hashes the Buffer.
//
// The cost is a readFileSync and a comparison. The benefit is precisely the
// class of error that struck TWICE in one day: the v1.6 distribution went out
// byte-identical to six repositories, and then the rendering defect in the
// correction block went out byte-identical to the same six. One comparison
// would have stopped both at the second repository.
//
// COPIED FROM, NOT IMPORTED: `workkit/test/unit/cockpit-pages/decisions.test.ts`
// (the §8 slice) and `watchkit/test/unit/cockpit-convention.test.ts` (the typed
// digest). The convention is a document, not a package (§7).
//
// AND ONE GAP THOSE VERSIONS HAVE, deliberately not inherited: they assert that
// ONE copy of §8 matches, never that there is only ONE. A second, contradicting
// `### 8.` section behind the first runs green there. Both shapes are covered
// below.
//
// It lives in tests/contract/ because CI's shard job runs `apps packages` only
// (LOCAL-SK-SCRIPTS-TESTS-NICHT-IN-CI). `bun run test:contract` runs this.
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
    // THE WHOLE FILE, and the digest is typed on purpose: this repository cannot
    // reach the five sibling checkouts, so the only thing it CAN hold is that
    // its own copy still has the bytes that were reviewed. Raising it is a
    // deliberate two-line change — the document and this line — and never
    // something a stray edit does quietly.
    //
    // LOCAL-SK-KONVENTION-KOPIE-WEICHT-AB — this pin held nothing for a day.
    // 87b94c38 dropped §15 (the Audit-Trail paragraph, 73 lines) from SubKit's
    // copy and RE-PINNED the digest to the shortened file, so the check went
    // green against a copy the five sibling repositories did not have. A pin
    // that is updated to whatever the file happens to be is a record of the
    // file, not a hold on it.
    //
    // So the value below is not "SubKit's current bytes" but the reviewed
    // document. v2.x is SubKit-first: SubKit authored it and carries it before
    // the five siblings, which keep v1.7 (md5 3ca37336047cb1ae1c51b789d1a91aa9)
    // until their own slices adopt v2.x byte for byte. The digest below is the
    // reviewed v2.3 text those slices will copy — v2.1 renamed the start page
    // back to „Übersicht" and put the operations bar above the attention list;
    // v2.1.1 adds the settings rows, filter, secrets and one-save bar to §6;
    // v2.3 adds cost and budget to that bar in short form. Raising it is a deliberate
    // two-line change — the document AND this line — and never a re-pin to
    // whatever the file happens to hold.
    const digest = createHash("sha256").update(konventionBytes).digest("hex");
    expect(digest, "COCKPIT-KONVENTION.md is no longer the reviewed v2.3 text").toBe(
      "21b45923319d53c0f7cf593ea1c6a4e0b3cec233fa257d5479044976114727e7",
    );
  });

  test("it carries the paragraphs v1.5 through v2.3 were cut for, not just its header", () => {
    // The digest above catches everything, but it catches it in one word:
    // "different". These name WHAT is missing when it goes red — and they are
    // the reason the two versions exist. A version line is one line, and one
    // line is what a hand edit changes: the header alone would pass on a file
    // saying 1.6 whose body is still 1.4, which is exactly the drift §7 leaves
    // to nobody.
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
    // §15 is the paragraph SubKit's copy lost. Named here so a repeat of that
    // truncation says WHICH section went missing instead of only "different".
    expect(konvention).toContain("## 15. Audit-Trail");
    expect(konvention).toContain("Zeitpunkt · Vorgang · Art · Ergebnis · Verursacher");
  });

  test("§8 exists exactly once in it", () => {
    expect([...konvention.matchAll(/^#{2,4} 8\. /gm)]).toHaveLength(1);
  });
});
