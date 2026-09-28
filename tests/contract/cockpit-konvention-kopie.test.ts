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
const UI_UX = join(root, "apps/cockpit/UI-UX.md");

const konventionBytes = readFileSync(KONVENTION);
const konvention = konventionBytes.toString("utf8");
const uiux = readFileSync(UI_UX, "utf8");

describe("the root copy of the family convention", () => {
  test("it is byte-identical to the reviewed v2.1 document", () => {
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
    // reviewed v2.1 text those slices will copy — v2.1 renames the start page
    // back to „Übersicht" and puts the operations bar above the attention list. Raising it is a deliberate
    // two-line change — the document AND this line — and never a re-pin to
    // whatever the file happens to hold.
    const digest = createHash("sha256").update(konventionBytes).digest("hex");
    expect(digest, "COCKPIT-KONVENTION.md is no longer the reviewed v2.1 text").toBe(
      "710c0e146445f82fa9aaecaae5a16e670074d361ccd210657c8b8c814fdcd7fb",
    );
  });

  test("it carries the paragraphs v1.5 through v2.1 were cut for, not just its header", () => {
    // The digest above catches everything, but it catches it in one word:
    // "different". These name WHAT is missing when it goes red — and they are
    // the reason the two versions exist. A version line is one line, and one
    // line is what a hand edit changes: the header alone would pass on a file
    // saying 1.6 whose body is still 1.4, which is exactly the drift §7 leaves
    // to nobody.
    expect(konvention).toContain("Version 2.1 · 28.09.2026");
    expect(konvention).toContain('**Leitregel (v2.1): Aufgaben leben nur auf der „Übersicht".**');
    expect(konvention).toContain("**Betriebsleiste.** Genau vier Werte in einer Zeile");
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

describe("the copy of §8 this product's attention page is measured against", () => {
  /** The §8 body of the family document, at the heading level the copy uses. */
  const source = konvention
    .slice(
      konvention.indexOf("## 8. Anliegen-Grammatik"),
      konvention.indexOf("## 9. Diff-Freigabe"),
    )
    .replace("## 8. Anliegen-Grammatik", "### 8. Anliegen-Grammatik")
    .trimEnd();

  /**
   * The copy runs from its heading to the end of the file, which is a fact
   * about UI-UX.md and is asserted as one below: everything product-specific
   * stands ABOVE the fence, so the copy is terminal and a second §8 section can
   * have nowhere to hide.
   */
  const copy = uiux.slice(uiux.indexOf("### 8. Anliegen-Grammatik")).trimEnd();

  test("UI-UX.md carries §8 word for word, only the heading level shifted", () => {
    // `.length` is UTF-16 code units, not bytes — see the note at the top of
    // this file. The floor is a floor either way; the label is what was wrong.
    expect(
      source.length,
      "the §8 slice of the family document is not empty (length in UTF-16 code units)",
    ).toBeGreaterThan(1_000);
    expect(copy).toBe(source);
  });

  test("there is exactly ONE §8 section in UI-UX.md, and nothing after it", () => {
    // THE GAP THE SISTER VERSIONS HAVE. Asserting that a copy matches says
    // nothing about a SECOND copy standing behind it: paste a contradicting
    // "### 8. Anliegen-Grammatik" after the fence and WatchKit's shape
    // stays green, because its slice stops at the first match. Two of them —
    // the count, and the fact that no heading of any level follows the fence,
    // so the text comparison above really covers the rest of the file. Text,
    // not bytes: `expect(copy).toBe(source)` compares decoded strings.
    expect([...uiux.matchAll(/^#{2,4} 8\. /gm)], "one §8 section, not two").toHaveLength(1);
    const fence = uiux.indexOf("### 8. Anliegen-Grammatik");
    expect(fence, "the fence is findable").toBeGreaterThan(0);
    // Sliced from AFTER the fence's own line, not from fence + 1: with the `m`
    // flag `^` also matches at index 0, so slicing into the middle of the
    // heading makes its own tail count as a heading and the assertion fails on
    // a clean file.
    const belowFence = uiux.slice(uiux.indexOf("\n", fence) + 1);
    expect(
      [...belowFence.matchAll(/^#{1,4} /gm)].map((hit) => hit[0]),
      "the verbatim copy is the last thing in the file — product-specific text belongs above it",
    ).toEqual([]);
  });

  test("the copy names its source and the version its source declares", () => {
    // THE VERSION IS NOT A LITERAL HERE, and that is a different case from
    // scripts/konvention-check.mjs, where writing it out is the whole point:
    // there the constant and the document are the two things being made to
    // agree. Here the two things are two FILES, so reading the number out of
    // one and demanding it in the other is exactly the disagreement worth
    // catching — this line said v1.4 while the root copy had moved on.
    expect(uiux).toContain("COCKPIT-KONVENTION.md");
    const declared = /^Version ([0-9]+\.[0-9]+) · /m.exec(konvention)?.[1];
    expect(declared, "COCKPIT-KONVENTION.md declares a version in its header line").toBeDefined();
    expect(uiux, `UI-UX.md names the version its source declares (v${declared})`).toContain(
      `v${declared}`,
    );
  });
});
