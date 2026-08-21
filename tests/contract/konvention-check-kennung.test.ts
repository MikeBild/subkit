// Der Kennungs-Assert des Konventions-Checks, maschinell gehalten.
//
// WARUM DIESE DATEI EXISTIERT
//
// `startPreview` beantwortet „antwortet dort etwas?" und nicht „antwortet dort
// SubKit?". Bei CodeKit ist der Unterschied real ausgelöst worden: WorkKit hielt
// CodeKits Prüfstands-Port, und der Konventions-Check erzeugte in 156 s acht
// Verstöße mit CodeKits Namen über eine Oberfläche, die nie CodeKit war. Kein
// Timeout, kein Absturz — ein vollständiger, überzeugender, falscher Bericht.
//
// Die Familie ist dafür gebaut: die Konvention macht die DOM-Verankerungen aller
// sechs Konsolen ABSICHTLICH gleich, also erfüllt eine fremde Schwesterkonsole
// alle Vorbedingungen, an denen ein Lauf sonst scheitern würde. Und die
// Prüfstände liegen dicht beieinander (4081 · 4173 · 4176 · 4183 · 4192).
//
// CodeKits Lösung hatte eine benannte Schwäche: der Sollwert stand als LITERAL im
// Skript, während ein Test denselben Wert aus der Quelle nahm — wer ihn umbenennt,
// bekommt „fremdes Dokument" über die EIGENE Konsole. Dieser Test hält die bessere
// Fassung fest: es gibt genau eine Definitionsstelle, `apps/cockpit/index.html`,
// und das Skript LIEST sie.
//
// Das Muster ist von WatchKit übernommen und ABGESCHRIEBEN, nicht importiert: die
// Konvention ist ein Dokument, kein Paket (§7).
// WARUM tests/contract/ UND NICHT scripts/__tests__/
//
// CIs Shard-Job laeuft `scripts/test-files-isolated.ts --shard N/8 apps packages`
// — `scripts` fehlt dort (LOCAL-SK-SCRIPTS-TESTS-NICHT-IN-CI). Ein Test unter
// scripts/__tests__/ liefe im lokalen Gate und in CI GAR NICHT, und ein Waechter
// ueber einer Pflichtstufe, den CI nie ausfuehrt, ist wieder nur ein Kommentar.
// tests/contract/ fuehrt CI ueber `bun run test:contract` wirklich aus.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const source = readFileSync(join(root, "scripts/konvention-check.mjs"), "utf8");

/**
 * Comments out, string literals intact.
 *
 * Both halves are load-bearing. Stripping only comments that OWN their line —
 * which is what a `/^\s*(\/\/|\*)/` regex does — leaves a TRAILING comment's
 * text in `code`, so an explanation mentioning the product name failed the ban
 * below instead of the abbreviation it is meant to catch. Cutting blindly at
 * "//" is the opposite trap: this script carries `http://` inside string
 * literals, and a blind cut takes the rest of those lines with it, which can
 * silently swallow the very occurrence the ban is looking for.
 *
 * Newlines survive so line numbers still line up with the file. A quote left
 * open at end of line is force-closed: a regex literal such as
 * /content="([^"]+)"/ leaves an odd number of quotes behind, and JS string
 * literals cannot span lines anyway, so any confusion stays on its own line.
 */
function stripComments(input: string): string {
  let out = "";
  let quote: string | null = null;
  let i = 0;
  while (i < input.length) {
    const c = input[i] as string;
    const next = input[i + 1];
    if (quote !== null) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === quote || (c === "\n" && quote !== "`")) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        if (input[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const code = stripComments(source);

const shell = readFileSync(join(root, "apps/cockpit/index.html"), "utf8");
const marker = /<meta[^>]+name="cockpit-product"[^>]+content="([^"]+)"/.exec(shell)?.[1];

/** Der Rumpf des Asserts — nicht die ganze Datei, siehe oben. */
function assertBody(): string {
  const start = code.indexOf("function assertPruefstandsKennung(html) {");
  expect(start, "der Kennungs-Assert ist auffindbar").toBeGreaterThan(0);
  return code.slice(start, code.indexOf("\n}\n", start));
}

describe("der Konventions-Check fragt, wessen Konsole geantwortet hat", () => {
  test("apps/cockpit/index.html ist die Definitionsstelle", () => {
    // Sichert jeden Satz darunter ab: ohne Marker in der Quelle wären die
    // Literal-Verbote stillschweigend wahr.
    expect(marker, 'apps/cockpit/index.html trägt <meta name="cockpit-product">').toBeTruthy();
    expect([...shell.matchAll(/name="cockpit-product"/g)]).toHaveLength(1);
  });

  test("der Assert leitet seinen Sollwert ab, statt ihn abzutippen", () => {
    expect(code).toContain(
      'const quelle = new URL("../apps/cockpit/index.html", import.meta.url);',
    );
    expect(code).toContain("const erwartet = markerIn(readFileSync(quelle,");

    const body = assertBody();
    expect(
      body.includes(`'${marker}'`) || body.includes(`"${marker}"`),
      `der Rumpf tippt „${marker}" ab, statt ihn aus apps/cockpit/index.html zu lesen`,
    ).toBe(false);
    // Und er benutzt auch die vorhandene Konstante nicht: `PRODUCT_NAME` ist
    // Prüfgegenstand von §6. Eine Kennung, die zugleich eine geprüfte Regel ist,
    // macht aus jedem echten Verstoß ein „das ist gar nicht SubKit".
    expect(body).not.toContain("PRODUCT_NAME");
    expect(body).not.toContain("<title>SubKit");
  });

  test("der Sollwert steht genau einmal im Code — als PRODUCT_NAME, sonst nirgends", () => {
    // Der Rumpf allein zu prüfen war umgehbar: ein `const RUECKFALL = "SubKit"`
    // auf Modulebene plus `erwartet || RUECKFALL` im Rumpf ließ alle sieben
    // Sätze grün, und der Assert hätte wieder einen abgetippten Sollwert gehabt.
    // Genau ein Vorkommen im ganzen Code, und es ist die Konstante, die §6
    // gegen die Wortmarke hält — jedes zweite ist der Rückfallwert.
    const literal = new RegExp(marker?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "", "g");
    const treffer = [...code.matchAll(literal)];
    expect(
      treffer,
      `„${marker}" steht ${treffer.length}× im Code, erlaubt ist genau 1×`,
    ).toHaveLength(1);
    expect(code).toContain(`const PRODUCT_NAME = "${marker}";`);
  });

  test("der Kommentar-Filter nimmt nachgestellte Kommentare mit und lässt Strings stehen", () => {
    // Der umgekehrte Fehlalarm: ohne diesen Filter macht ein nachgestellter
    // Kommentar mit dem Produktnamen den Satz darüber grundlos rot.
    expect(stripComments(`const a = 1; // ${marker} erklärt hier etwas`)).toBe("const a = 1; ");
    expect(stripComments('const u = "http://127.0.0.1:4176/cockpit/";')).toBe(
      'const u = "http://127.0.0.1:4176/cockpit/";',
    );
    // Und der Filter darf die Datei nicht auffressen: die Zeilen bleiben stehen.
    expect(code.split("\n")).toHaveLength(source.split("\n").length);
  });

  test("ein umbenanntes Attribut ist ein Befund über DIESES Repository", () => {
    // Die Meldung, die CodeKits Fassung falsch herum gibt: dort sagt ein
    // umbenannter Marker „fremdes Dokument" über die eigene Konsole.
    // Der erwartete Wert IST der Quelltext des Skripts; ein Template-Literal hier löste
    // ihn auf, statt ihn zu prüfen.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: geprüft wird der Quelltext, nicht sein Ergebnis
    expect(code).toContain('trägt kein <meta name="${IDENTITY_META}" content="…"> mehr.');
    expect(code).toContain("das ist ein Befund über DIESES Repository");
  });

  test("eine fremde Konsole wird BENANNT, nicht nur abgelehnt", () => {
    // Der Fortschritt gegenüber CodeKit: der Lauf sagt, wer geantwortet hat.
    expect(code).toContain("Sein Titel lautet");
    // Der erwartete Wert IST der Quelltext des Skripts; ein Template-Literal hier löste
    // ihn auf, statt ihn zu prüfen.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: geprüft wird der Quelltext, nicht sein Ergebnis
    expect(code).toContain("das ist nicht ${erwartet}, sondern ${geliefert}");
  });

  test("die Kennung wird VOR dem Browserstart geprüft", () => {
    // Sonst kostet ein fremdes Gegenüber erst den ganzen Lauf und wird dann
    // verworfen — bei CodeKit 156 Sekunden.
    const kennung = code.indexOf("assertPruefstandsKennung(preview.shell);");
    const browser = code.indexOf("await chromium.launch(");
    expect(kennung, "der Assert wird aufgerufen").toBeGreaterThan(0);
    expect(browser, "der Browser wird gestartet").toBeGreaterThan(0);
    expect(kennung).toBeLessThan(browser);
  });

  test("geprüft wird das Dokument, auf das gewartet wurde — nicht ein zweites", () => {
    // Zwei Abrufe wären zwei Dokumente, und die Kennung prüfte dann eines, das
    // der Lauf nie gemessen hat.
    expect(code).toContain("if (response.ok) return { server, shell: await response.text() };");
    expect(code).toContain("assertPruefstandsKennung(preview.shell);");
  });

  test("„nicht gemessen“ hat einen eigenen Ausgang", () => {
    // 1 heißt „gemessen und rot" und ist eine Arbeitsliste. 2 heißt „es wurde
    // nichts gemessen" — für eine Pflichtstufe der Unterschied zwischen
    // reparieren und stummschalten.
    expect(code).toContain("class NichtGemessen extends Error {}");
    expect(code).toContain("process.exit(nichtGemessen ? 2 : 1);");
    // Und „nicht gemessen" endet nicht bei der ersten Route: ein Abbruch
    // mitten im Sweep — bei einem gestorbenen Vorschau-Server Route 11 von 27 —
    // hat die Routenliste nicht durchlaufen und ist deshalb genauso wenig eine
    // Messung wie ein fremdes Gegenüber vor der ersten.
    expect(code).toContain(
      "const nichtGemessen = abbruch instanceof NichtGemessen || (Boolean(abbruch) && !routenDurchlaufen);",
    );
    expect(code).toContain("routenDurchlaufen = true;");
    // Alle drei Zweige des Asserts nehmen diesen Ausgang.
    expect([...assertBody().matchAll(/throw new NichtGemessen\(/g)]).toHaveLength(3);
  });
});
