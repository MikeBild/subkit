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

// Kommentare raus, bevor irgendetwas verboten wird. „SubKit" steht in diesem
// Skript legitim — als `PRODUCT_NAME`, den §6 gegen die Wortmarke hält, und in
// jedem erklärenden Absatz. Ein Test, der die Kommentare mitliest, verböte das
// Erklären statt das Abtippen.
const code = source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

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
    expect(code).toContain("process.exit(abbruch instanceof NichtGemessen ? 2 : 1);");
    // Alle drei Zweige des Asserts nehmen diesen Ausgang.
    expect([...assertBody().matchAll(/throw new NichtGemessen\(/g)]).toHaveLength(3);
  });
});
