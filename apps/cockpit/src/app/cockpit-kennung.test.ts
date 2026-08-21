// Die Kennung im AUSGELIEFERTEN Dokument, maschinell gehalten.
//
// scripts/konvention-check.mjs prüft den Marker am gelieferten Dokument des
// Prüfstands und beantwortet damit „wessen Konsole hat geantwortet?". Diese Datei
// prüft ihn an der GEBAUTEN Fassung, denn nur die wird ausgeliefert: ein Marker,
// den der Bau wegwirft, umbenennt oder verdoppelt, macht aus jedem Lauf gegen die
// eigene Konsole ein „fremdes Dokument" — die Meldung, die am teuersten falsch ist.
// Dieselbe Rechnung wie beim Favicon (cockpit-favicon.test.ts), aus demselben
// Grund: Quelle und gebaute Fassung sind zwei Wahrheiten, solange niemand sie
// gegeneinander hält.
//
// Und der Wert wird gegen `package.json` gehalten statt hier wiederholt: der
// Marker existiert, um zu sagen WELCHES Produkt das ist. Einer, der vom Namen des
// Produkts wegdriften kann, wäre schlimmer als keiner — er behauptet eine
// Identität, die niemand mehr prüft.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_COCKPIT } from "../../../engine/src/http/cockpit-embedded.ts";

const root = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
const sourceHtml = readFileSync(join(root, "apps/cockpit/index.html"), "utf8");
const builtHtml = readFileSync(join(root, "assets/cockpit/index.html"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string };

const MARKER = /<meta[^>]+name="cockpit-product"[^>]+content="([^"]+)"/;

/** Die Kennung eines Dokuments, oder null wenn es keine trägt. */
function kennung(html: string): string | null {
  return MARKER.exec(html)?.[1] ?? null;
}

describe("die gebaute Konsole sagt, welches Produkt sie ist", () => {
  test("die Quelle trägt genau eine Definitionsstelle", () => {
    expect(kennung(sourceHtml)).toBeString();
    expect([...sourceHtml.matchAll(/name="cockpit-product"/g)]).toHaveLength(1);
  });

  test("die gebaute Fassung trägt sie unverändert und genau einmal", () => {
    // Vite schreibt `href` und `src` um, nicht `content` — dieser Satz macht aus
    // dieser Erwartung eine Zusicherung.
    expect(kennung(builtHtml)).toBe(kennung(sourceHtml));
    expect(
      [...builtHtml.matchAll(/name="cockpit-product"/g)],
      "zwei Marker sind zwei Antworten auf dieselbe Frage",
    ).toHaveLength(1);
  });

  test("die Kennung IST der Produktname aus package.json", () => {
    expect(kennung(builtHtml)?.toLowerCase()).toBe(pkg.name.toLowerCase());
  });

  test("die eingebettete Kopie trägt sie auch", () => {
    // `bun build --compile` liefert das Cockpit aus cockpit-embedded.ts aus, nicht
    // aus assets/cockpit. Eine Kennung, die nur auf der Platte steht, beantwortet
    // die Frage genau dort nicht, wo sie ein Betreiber stellt.
    const embedded = Buffer.from(EMBEDDED_COCKPIT["index.html"] ?? "", "base64").toString("utf8");
    expect(kennung(embedded)).toBe(kennung(sourceHtml));
  });

  test("die Kennung ist NICHT der Titel und nicht die Wortmarke", () => {
    // §6 prüft Browser-Titel und Wortmarke; eine Kennung, die zugleich
    // Prüfgegenstand ist, macht aus jedem echten Verstoß ein „das ist gar nicht
    // SubKit" und misst danach nichts mehr. Der Titel darf die Kennung enthalten,
    // aber er darf sie nicht SEIN.
    const titel = /<title>([^<]*)<\/title>/.exec(builtHtml)?.[1]?.trim();
    expect(titel).toBeString();
    expect(titel).not.toBe(kennung(builtHtml));
  });
});
